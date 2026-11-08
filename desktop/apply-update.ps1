param([int]$ParentId,[string]$Target,[string]$Package,[switch]$NoLaunch,[string]$ReadyFile)
$ErrorActionPreference='Stop'
$targetRoot=[IO.Path]::GetFullPath($Target).TrimEnd('\')
$runtime=Join-Path $targetRoot 'runtime\electron.exe'
$statusFile=Join-Path $targetRoot '.run\updates\last-install.json'
$updateVersion=(Get-Content -LiteralPath (Join-Path $Package 'update-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
New-Item -ItemType Directory -Force -Path (Split-Path $statusFile -Parent) | Out-Null
$progressFile=Join-Path $targetRoot '.run\updates\install-progress.log'
[IO.File]::AppendAllText($progressFile,((Get-Date).ToString('o')+' started'+[Environment]::NewLine))
if($ReadyFile){
    $readyPath=[IO.Path]::GetFullPath($ReadyFile)
    if(-not $readyPath.StartsWith(($targetRoot+'\.run\updates\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid ready marker path'}
    [IO.File]::WriteAllText($readyPath,'ready')
}
$started=Get-Date
$backupsBefore=@(Get-ChildItem -LiteralPath (Join-Path $targetRoot '.rollback') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
try {
    for($attempt=0;$attempt -lt 120;$attempt++){
        $parentRunning=Get-Process -Id $ParentId -ErrorAction SilentlyContinue
        $runtimeRunning=Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object ExecutablePath -eq $runtime
        if(-not $parentRunning -and -not $runtimeRunning){break}
        Start-Sleep -Milliseconds 500
    }
    if($parentRunning -or $runtimeRunning){throw 'Client did not exit; update cancelled'}
    [IO.File]::AppendAllText($progressFile,('client exited; installing'+[Environment]::NewLine))
    & (Join-Path $Package 'Update-Friends.ps1') -Target $targetRoot -NoLaunch
    @{ok=$true;version=$updateVersion;at=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
    [IO.File]::AppendAllText($progressFile,('installed'+[Environment]::NewLine))
} catch {
    $failure=$_.Exception.Message
    [IO.File]::AppendAllText($progressFile,('failed: '+$failure+[Environment]::NewLine))
    $backup=Get-ChildItem -LiteralPath (Join-Path $targetRoot '.rollback') -Directory -ErrorAction SilentlyContinue | Where-Object {$_.FullName -notin $backupsBefore -and $_.CreationTime -ge $started.AddSeconds(-2)} | Sort-Object CreationTime -Descending | Select-Object -First 1
    if($backup){
        $backupRoot=[IO.Path]::GetFullPath($backup.FullName).TrimEnd('\')+'\'
        if(-not $backupRoot.StartsWith(($targetRoot+'\.rollback\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid rollback directory'}
        foreach($file in Get-ChildItem -LiteralPath $backupRoot -File -Recurse){
            $destination=[IO.Path]::GetFullPath((Join-Path $targetRoot $file.FullName.Substring($backupRoot.Length)))
            if(-not $destination.StartsWith(($targetRoot+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid rollback path'}
            New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        }
    }
    @{ok=$false;version=$updateVersion;at=(Get-Date).ToString('o');message=$failure} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
if(-not $NoLaunch){& (Join-Path $targetRoot 'Start-Friends.ps1')}
