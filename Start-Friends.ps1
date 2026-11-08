param([ValidatePattern('^[A-Za-z0-9_-]{3,100}$')][string]$Room)
$ErrorActionPreference='Stop'
$clientExe=Join-Path $PSScriptRoot 'runtime\electron.exe'
if(-not(Test-Path -LiteralPath $clientExe)){throw 'The desktop runtime is missing. Please extract the complete ZIP first.'}
$clientArgs=@(('"'+$PSScriptRoot+'"'))
if($Room){$clientArgs+=('--room='+$Room)}
Start-Process -FilePath $clientExe -ArgumentList $clientArgs -WorkingDirectory $PSScriptRoot
