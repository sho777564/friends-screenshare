$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ ('/out:'+(Join-Path $PSScriptRoot 'CoopInputHost.exe')) /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'CoopInput.cs')
if($LASTEXITCODE){throw 'Native input helper compilation failed'}
