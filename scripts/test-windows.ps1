param([string]$workerDirectory, [switch]$upgradeAcceptance, [switch]$releaseCandidate)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($workerDirectory) {
    $log = Join-Path $workerDirectory 'checks.log'
    $code = 1
    try {
        $settings = Get-Content -LiteralPath (Join-Path $workerDirectory 'settings.json') -Raw | ConvertFrom-Json
        if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $settings.sid) {
            throw 'Independent validation must use the initiating account.'
        }
        Set-Location -LiteralPath $repo
        $env:PATH = $settings.path
        $env:CARGO = $settings.cargo
        $env:CI = 'true'
        $env:GITHUB_ACTIONS = 'true'
        $env:RUNNER_TRACKING_ID = $settings.trackingId
        if ($settings.upgradeAcceptance) {
            $arguments = @('scripts/upgrade-acceptance.mjs')
            if ($settings.releaseCandidate) { $arguments += '--release' }
            & $settings.node @arguments *> $log
            $code = $LASTEXITCODE
        } else {
            & $settings.node scripts/test-rust.mjs *> $log
            $code = $LASTEXITCODE
            if ($code -eq 0) {
                & $settings.npm test *>> $log
                $code = $LASTEXITCODE
            }
        }
    } catch {
        $_.ToString() | Out-File -LiteralPath $log -Append -Encoding utf8
        $code = 1
    } finally {
        $result = Join-Path $workerDirectory 'result.json'
        @{ exitCode = $code } | ConvertTo-Json | Set-Content -LiteralPath "$result.tmp" -Encoding utf8
        Move-Item -LiteralPath "$result.tmp" -Destination $result
    }
    exit $code
}

if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'This independent Windows validation host is for GitHub Actions only.'
}
$workerDirectory = Join-Path $repo ('outputs/windows-checks-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workerDirectory | Out-Null
@{
    path = $env:PATH
    cargo = (Get-Command cargo).Source
    node = (Get-Command node).Source
    npm = (Get-Command npm.cmd).Source
    trackingId = $env:RUNNER_TRACKING_ID
    sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    upgradeAcceptance = [bool]$upgradeAcceptance
    releaseCandidate = [bool]$releaseCandidate
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workerDirectory 'settings.json') -Encoding utf8

# Cargo and the Actions command host both use jobs. WMI creates a same-user
# validation process outside the launcher's job, without changing any job policy,
# installing a service or granting privileges. Production handoff checks remain
# active, including the explicitly restrictive synthetic SSH job tests.
$shell = Join-Path $PSHOME 'pwsh.exe'
$script = Join-Path $PSScriptRoot 'test-windows.ps1'
# PowerShell needs valid console handles during startup. Create a hidden console
# and escape the provider's quota job, with bootstrap diagnostics owned by this run.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x01000010 }
$bootstrap = Join-Path $workerDirectory 'bootstrap.log'
$invocation = "& '" + $script.Replace("'", "''") + "' -workerDirectory '" + $workerDirectory.Replace("'", "''") + "' *> '" + $bootstrap.Replace("'", "''") + "'"
$process = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command `"$invocation`""
    CurrentDirectory = $repo
    ProcessStartupInformation = $startup
}
if ($process.ReturnValue -ne 0) { throw "Independent Windows validation failed to start ($($process.ReturnValue))." }
Write-Output 'Independent Windows validation started.'
$deadline = [DateTime]::UtcNow.AddMinutes($(if ($upgradeAcceptance) { 40 } else { 20 }))
$result = Join-Path $workerDirectory 'result.json'
while (!(Test-Path -LiteralPath $result)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Independent Windows validation exceeded its deadline; private diagnostics retained.' }
    if (!(Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)") -and !(Test-Path -LiteralPath $result)) {
        if (Test-Path -LiteralPath $bootstrap) { Get-Content -LiteralPath $bootstrap }
        throw 'Independent Windows validation exited without publishing a result; private diagnostics retained.'
    }
    Start-Sleep -Seconds 1
}
Get-Content -LiteralPath (Join-Path $workerDirectory 'checks.log')
$outcome = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
exit $outcome.exitCode
