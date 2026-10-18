[CmdletBinding()]
param(
  [string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) "models")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null

function Get-VerifiedModel {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Uri,
    [Parameter(Mandatory)][long]$Size,
    [Parameter(Mandatory)][ValidateSet("SHA256", "SHA384")][string]$Algorithm,
    [Parameter(Mandatory)][string]$Digest
  )

  $target = Join-Path $destinationPath $Name
  if (Test-Path -LiteralPath $target) {
    $file = Get-Item -LiteralPath $target
    $hash = (Get-FileHash -LiteralPath $target -Algorithm $Algorithm).Hash
    if ($file.Length -eq $Size -and $hash -eq $Digest) {
      Write-Host "$Name already verified."
      return
    }
    throw "Existing model failed verification: $target"
  }

  $temporary = Join-Path $destinationPath (".{0}.{1}.download" -f $Name, [Guid]::NewGuid().ToString("N"))
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $temporary
    $file = Get-Item -LiteralPath $temporary
    if ($file.Length -ne $Size) {
      throw "$Name has unexpected size $($file.Length); expected $Size"
    }
    $hash = (Get-FileHash -LiteralPath $temporary -Algorithm $Algorithm).Hash
    if ($hash -ne $Digest) {
      throw "$Name checksum verification failed"
    }
    Move-Item -LiteralPath $temporary -Destination $target
    Write-Host "$Name downloaded and verified."
  }
  finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

Get-VerifiedModel `
  -Name "face_detection_yunet_2023mar.onnx" `
  -Uri "https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" `
  -Size 232589 `
  -Algorithm "SHA256" `
  -Digest "8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4"

Get-VerifiedModel `
  -Name "arcfaceresnet100-8.onnx" `
  -Uri "https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/face-recognition-resnet100-arcface-onnx/arcfaceresnet100-8.onnx" `
  -Size 261036388 `
  -Algorithm "SHA384" `
  -Digest "4BCEB34EE96C7C0B544012BE53870D757F332D9D2972962065618DE6942CF60F63B94F702F85FCC31844B21DE326EC72"

