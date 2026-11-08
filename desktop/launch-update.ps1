param([int]$ParentId,[string]$Target,[string]$Package,[string]$ReadyFile)
$ErrorActionPreference='Stop'
$helper=Join-Path $PSScriptRoot 'apply-update.ps1'
$helperArgs=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$helper+'"'),'-ParentId',$ParentId,'-Target',('"'+$Target+'"'),'-Package',('"'+$Package+'"'),'-ReadyFile',('"'+$ReadyFile+'"'))
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $helperArgs -WindowStyle Hidden
