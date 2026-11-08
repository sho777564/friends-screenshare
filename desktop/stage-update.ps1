param([string]$Archive,[string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stageRoot=[IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
if(Test-Path -LiteralPath $stageRoot){throw 'Staging folder must be new'}
New-Item -ItemType Directory -Path $stageRoot | Out-Null
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if($zip.Entries.Count -gt 4000){throw 'Too many update files'}
    [long]$bytes=0
    foreach($entry in $zip.Entries){
        if($entry.FullName.Contains(':') -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Invalid update entry'}
        $file=[IO.Path]::GetFullPath((Join-Path $stageRoot $entry.FullName))
        if(-not $file.StartsWith($stageRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe update path'}
        if($entry.FullName.EndsWith('/')){New-Item -ItemType Directory -Force -Path $file | Out-Null;continue}
        New-Item -ItemType Directory -Force -Path (Split-Path $file -Parent) | Out-Null
        $inputStream=$entry.Open();$outputStream=[IO.File]::Open($file,[IO.FileMode]::CreateNew)
        try {
            $buffer=New-Object byte[] 8192
            while(($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0){
                $bytes+=$count;if($bytes -gt 67108864){throw 'Update expands beyond size limit'}
                $outputStream.Write($buffer,0,$count)
            }
        } finally {$inputStream.Dispose();$outputStream.Dispose()}
    }
} finally {$zip.Dispose()}
