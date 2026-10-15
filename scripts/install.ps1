param(
    [string]$Version = 'latest',
    [string]$InstallDir = $(if ($env:DEWBOW_INSTALL_DIR) { $env:DEWBOW_INSTALL_DIR } else { Join-Path $HOME '.local\bin' })
)
# Keep preferences local when this script is evaluated with Invoke-Expression.
& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    if ($env:OS -ne 'Windows_NT' -or [Environment]::Is64BitOperatingSystem -eq $false -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'This installer supports Windows x64. Use install.sh on supported Linux/macOS systems.'
    }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (!(Test-Path -LiteralPath $tar -PathType Leaf)) { throw 'Windows system tar.exe is required.' }
    # Windows PowerShell 5.1 may otherwise negotiate a retired TLS version.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($Version -eq 'latest') {
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/rovewyn/dewbow/releases/latest' -TimeoutSec 30 -Headers @{ 'User-Agent' = 'dewbow-installer' }
        if ($release.draft -or $release.prerelease) { throw 'Expected a published stable release.' }
        $Version = $release.tag_name
    }
    if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
        throw 'Expected an unprefixed SemVer version.'
    }
    if ([string]::IsNullOrWhiteSpace($InstallDir)) { throw 'Installation directory is empty.' }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $ancestor = $InstallDir
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation paths are unsupported.' }
        }
        $ancestor = Split-Path -Path $ancestor -Parent
    }
    [IO.Directory]::CreateDirectory($InstallDir) | Out-Null
    $destination = Join-Path $InstallDir 'dewbow.exe'
    if (Test-Path -LiteralPath $destination) {
        throw 'Dewbow already exists in this directory. Use dewbow upgrade.'
    }
    $stage = Join-Path $InstallDir ('.dewbow-install-' + [guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $name = "dewbow-$Version-x86_64-pc-windows-msvc"
        $archiveName = "$name.zip"
        $archive = Join-Path $stage $archiveName
        $checksum = Join-Path $stage 'checksum'
        $base = "https://github.com/rovewyn/dewbow/releases/download/$Version/$archiveName"
        Invoke-WebRequest -Uri $base -OutFile $archive -UseBasicParsing -TimeoutSec 180
        Invoke-WebRequest -Uri "$base.sha256" -OutFile $checksum -UseBasicParsing -TimeoutSec 30
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ((Get-Content -LiteralPath $checksum -Raw).Trim() -cne "$actual  $archiveName") { throw 'Release archive checksum does not match.' }
        $entries = @(& $tar -tf $archive)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot list the release archive.' }
        $allowed = @("$name/dewbow.exe", "$name/CLI.md", "$name/release.json")
        foreach ($entry in $entries) { if ($entry -cne "$name/" -and $entry -cnotin $allowed) { throw 'Unexpected release archive entry.' } }
        foreach ($entry in $allowed) { if (@($entries | Where-Object { $_ -ceq $entry }).Count -ne 1) { throw 'Missing or duplicate release archive entry.' } }
        $details = @(& $tar -tvf $archive)
        if ($LASTEXITCODE -ne 0 -or @($details | Where-Object { $_ -cnotmatch '^[-d]' }).Count -ne 0) { throw 'Links and special files are unsupported in release archives.' }
        & $tar -xf $archive -C $stage
        if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the release archive.' }
        $candidate = Join-Path (Join-Path $stage $name) 'dewbow.exe'
        $metadata = Get-Content -LiteralPath (Join-Path (Join-Path $stage $name) 'release.json') -Raw | ConvertFrom-Json
        if ($metadata.version -cne $Version -or $metadata.target -cne 'x86_64-pc-windows-msvc' -or $metadata.executable -cne 'dewbow.exe' -or
            $metadata.binarySha256 -cne (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Release manifest does not match the executable, version or target.' }
        $reported = & $candidate --version
        if ($LASTEXITCODE -ne 0 -or $reported -cne "dewbow $Version") { throw 'Downloaded executable reports the wrong version.' }
        # File.Move refuses to overwrite a concurrent install, including on PS 5.1.
        [IO.File]::Move($candidate, $destination)
        Write-Output "Installed Dewbow $Version in $InstallDir"
        if ($InstallDir -notin ($env:PATH -split ';')) { Write-Output "Add this directory to PATH: $InstallDir" }
        Write-Output 'Run dewbow --version, then dewbow init and dewbow doctor. Codex is installed separately.'
    } finally {
        # The freshly created UUID directory is the only recursive cleanup target.
        if ((Split-Path -Path $stage -Parent) -ne $InstallDir -or (Split-Path -Path $stage -Leaf) -notlike '.dewbow-install-*') { throw 'Unexpected installer staging path.' }
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
