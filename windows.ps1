param(
    [ValidateSet('Start', 'Stop', 'Install', 'Uninstall', 'Status')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$taskName = 'CodexQuotaMonitor'
$scriptPath = $PSCommandPath
$serverPath = Join-Path $PSScriptRoot 'server.js'
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$dataDir = Join-Path $env:LOCALAPPDATA 'CodexQuotaMonitor'
$configPath = Join-Path $dataDir 'config.json'
$port = 17880
if (Test-Path -LiteralPath $configPath) {
    $port = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).port
}
if ($port -lt 1024 -or $port -gt 65535 -or $port -ne [int]$port) {
    throw '本机端口配置无效。'
}
$url = 'http://127.0.0.1:' + $port + '/'
$processPattern = '(?i)(^|\s)"?' + [regex]::Escape($serverPath) + '"?(?=\s|$)'

function Get-MonitorProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.ExecutablePath -eq $nodePath -and $_.CommandLine -match $processPattern
    }
}

function Test-MonitorReady {
    $request = [Net.HttpWebRequest]::Create($url + 'api/status')
    $request.Proxy = $null
    $request.Timeout = 1000
    try { $response = $request.GetResponse(); $response.Close(); return $true }
    catch { return $false }
}

function Start-Monitor {
    $running = @(Get-MonitorProcesses)
    if ($running.Count) {
        Write-Output ('服务已在运行，PID：' + ($running.ProcessId -join ', ') + '；' + $url)
        return
    }
    if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw ('端口 ' + $port + ' 已被占用；未启动第二个服务。')
    }
    [IO.Directory]::CreateDirectory($dataDir) | Out-Null
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $dataDir 'startup.log') `
        -RedirectStandardError (Join-Path $dataDir 'startup-error.log')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 15) {
        $process.Refresh()
        if ($process.HasExited) { throw '启动失败，请查看本机 startup-error.log。' }
        if (Test-MonitorReady) {
            Write-Output ('服务已隐藏启动，PID：' + $process.Id + '；' + $url)
            return
        }
        Start-Sleep -Milliseconds 200
    }
    throw '服务启动未及时完成，请查看本机 startup-error.log。'
}

function Get-MonitorTask {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and -not ($task.Actions | Where-Object { $_.Arguments.Contains('"' + $scriptPath + '"') })) {
        throw '存在同名的其他计划任务，未修改它。'
    }
    return $task
}

function Write-DesktopPage {
    $desktopPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex额度监控.html'
    if ((Test-Path -LiteralPath $desktopPath) -and
        -not ([IO.File]::ReadAllText($desktopPath).Contains('<!-- CodexQuotaMonitor launcher -->'))) {
        throw '桌面已有同名的其他文件，未覆盖它。'
    }
    $html = @"
<!doctype html>
<!-- CodexQuotaMonitor launcher -->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=$url">
<title>Codex 额度监控</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:16px system-ui,"Microsoft YaHei",sans-serif}main{padding:36px;text-align:center}h1{font-size:28px}p{color:#6e6e73}a{display:inline-block;padding:12px 24px;border-radius:24px;background:#007aff;color:white;text-decoration:none}</style>
</head>
<body><main><h1>Codex 额度监控</h1><p>正在打开本机监控页…</p><a href="$url">打开监控页</a><p>网页无法打开时，请先启动后台服务。</p></main></body>
</html>
"@
    [IO.File]::WriteAllText($desktopPath, $html, [Text.UTF8Encoding]::new($false))
    Write-Output ('桌面入口已创建：' + $desktopPath)
}

switch ($Action) {
    'Start' { Start-Monitor }
    'Stop' {
        foreach ($process in @(Get-MonitorProcesses)) {
            # 停止前重新核对命令行，避免 PID 复用误停其他程序。
            $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $process.ProcessId)
            if ($current.ExecutablePath -eq $nodePath -and $current.CommandLine -match $processPattern) {
                Stop-Process -Id $current.ProcessId
                Write-Output ('服务已停止，PID：' + $current.ProcessId)
            }
        }
    }
    'Install' {
        Get-MonitorTask | Out-Null
        $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '" -Action Start'
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $PSScriptRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $taskAction -Trigger $trigger `
            -Principal $principal -Settings $settings -Description '登录后隐藏启动本机 Codex 额度监控；不自动打开网页。' -Force | Out-Null
        Write-DesktopPage
        Start-Monitor
        Write-Output 'Windows 登录自动启动已安装。'
    }
    'Uninstall' {
        if (Get-MonitorTask) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
        Write-Output '自动启动已移除；当前运行的服务和桌面入口保留。'
    }
    'Status' {
        $running = @(Get-MonitorProcesses)
        Write-Output ('服务进程数：' + $running.Count + '；PID：' + ($running.ProcessId -join ', '))
        Write-Output ('监控页：' + $url)
        $task = Get-MonitorTask
        if ($task) { Write-Output ('自动启动：已安装；计划任务状态：' + $task.State) }
        else { Write-Output '自动启动：未安装' }
    }
}
