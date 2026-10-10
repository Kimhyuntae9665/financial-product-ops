param([switch]$Install,[switch]$UseExistingModel,[string]$ModelName='Qwen3-1.7B Q4_K_M',[string]$ModelCompute='this-pc',[ValidateSet('CPU','Vulkan')][string]$ModelBackend='CPU',[ValidateSet(4096,8192)][int]$ModelContext=8192)
$ErrorActionPreference='Stop'
$financeNode=(Get-Command node.exe).Source
$financeNpm=(Get-Command npm.cmd).Source
$financeSettings=Join-Path $PSScriptRoot '.runtime.json'
$financeRuntime=if(Test-Path -LiteralPath $financeSettings){(Get-Content -LiteralPath $financeSettings -Raw|ConvertFrom-Json).runtimeDir}else{Join-Path (Split-Path -Parent $PSScriptRoot) 'work/openclaw-runtime'}
$env:FINANCE_RUNTIME_DIR=$financeRuntime
$env:FINANCE_MODEL_NAME=$ModelName
$env:FINANCE_MODEL_COMPUTE=$ModelCompute
$env:FINANCE_MODEL_BACKEND=$ModelBackend
$env:FINANCE_MODEL_CONTEXT=$ModelContext
New-Item -ItemType Directory -Force -Path $financeRuntime|Out-Null
if($Install){
  & $financeNpm install --prefix $financeRuntime openclaw@2026.9.9 --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'OpenClaw installation failed.'}
  if(!$UseExistingModel){
  $financeCache=Split-Path -Parent $financeRuntime
  $financeModel=Join-Path $financeCache 'llm-models/Qwen3-1.7B-Q4_K_M.gguf'
  $financeArchive=Join-Path $financeCache 'llama-runtime/llama-b11429-bin-win-vulkan-x64.zip'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $financeModel),(Split-Path -Parent $financeArchive)|Out-Null
  foreach($financeDownload in @(
    @{Path=$financeModel;Hash='b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897';Url='https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf'},
    @{Path=$financeArchive;Hash='1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36';Url='https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-vulkan-x64.zip'}
  )){
    if(!(Test-Path -LiteralPath $financeDownload.Path)){
      & curl.exe --fail --location --retry 2 --output $financeDownload.Path $financeDownload.Url
      if($LASTEXITCODE -ne 0){throw 'Download incomplete. It will not be executed.'}
    }
    if((Get-FileHash -LiteralPath $financeDownload.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $financeDownload.Hash){throw "SHA256 mismatch: $($financeDownload.Path)"}
  }
  Expand-Archive -LiteralPath $financeArchive -DestinationPath (Join-Path $financeCache 'llama-runtime/b11429') -Force
  }
}
& $financeNode (Join-Path $PSScriptRoot 'setup.mjs')
if($LASTEXITCODE -ne 0){throw 'Config setup failed.'}
if($UseExistingModel){
  $financeModels=Invoke-RestMethod -Uri 'http://127.0.0.1:8090/v1/models' -TimeoutSec 5
  if(!($financeModels.data|Where-Object {$_.id -eq 'finance-qwen'})){throw 'Existing model must expose alias finance-qwen on loopback port 8090.'}
}else{
  & $financeNode (Join-Path $PSScriptRoot 'model.mjs')
  if($LASTEXITCODE -ne 0){throw 'Model start failed.'}
}
Write-Output 'Open http://127.0.0.1:4330/ . Ctrl+C stops this console.'
& $financeNode (Join-Path $PSScriptRoot 'server.mjs')
