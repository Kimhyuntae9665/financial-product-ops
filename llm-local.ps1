param([ValidateSet('Install','Start','Status','Stop')][string]$Mode='Start')
$ErrorActionPreference='Stop'
$opsParent=Split-Path -Parent $PSScriptRoot
$opsWork=if((Split-Path -Leaf $opsParent) -eq 'outputs'){Join-Path (Split-Path -Parent $opsParent) 'work'}else{Join-Path $PSScriptRoot 'work'}
$opsModelDir=Join-Path $opsWork 'llm-models'
$opsRuntimeDir=Join-Path $opsWork 'llama-runtime'
$opsModel=Join-Path $opsModelDir 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
$opsArchive=Join-Path $opsRuntimeDir 'llama-b11429-bin-win-vulkan-x64.zip'
$opsRuntime=Join-Path $opsRuntimeDir 'b11429'
$opsServer=Join-Path $opsRuntime 'llama-server.exe'
$opsPidFile=Join-Path $opsWork 'llama-notice.pid'
$opsModelHash='6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
$opsArchiveHash='1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36'
function Test-OpsModelServer {
  try { $opsModels=Invoke-RestMethod 'http://127.0.0.1:8089/v1/models' -TimeoutSec 2; return [bool]($opsModels.data | Where-Object id -eq 'notice-reader') } catch { return $false }
}
function Assert-OpsHash([string]$Path,[string]$Hash) {
  if(!(Test-Path -LiteralPath $Path)){throw "Missing file: $Path. Run llm-local.ps1 -Mode Install first."}
  if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash){throw "SHA256 mismatch: $Path. The file was not executed."}
}
if($Mode -eq 'Status') {
  Write-Output ([pscustomobject]@{Connected=(Test-OpsModelServer);Endpoint='http://127.0.0.1:8089';Alias='notice-reader';Model='Qwen2.5-1.5B-Instruct Q4_K_M';ModelPath=$opsModel})
  exit
}
if($Mode -eq 'Stop') {
  if(!(Test-Path -LiteralPath $opsPidFile)){Write-Output 'No helper-owned process recorded. No process stopped.';exit}
  $opsRecordedId=[int]([IO.File]::ReadAllText($opsPidFile).Trim())
  $opsRecordedProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$opsRecordedId"
  if($opsRecordedProcess -and $opsRecordedProcess.ExecutablePath -eq $opsServer -and $opsRecordedProcess.CommandLine -match 'notice-reader'){
    Stop-Process -Id $opsRecordedId
    Write-Output 'Stopped the recorded local notice model server.'
  }else{Write-Output 'Recorded process is no longer the expected server. No process stopped.'}
  exit
}
if($Mode -eq 'Install') {
  New-Item -ItemType Directory -Force -Path $opsModelDir,$opsRuntimeDir | Out-Null
  foreach($opsDownload in @(
    @{Path=$opsModel;Hash=$opsModelHash;Url='https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf'},
    @{Path=$opsArchive;Hash=$opsArchiveHash;Url='https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-vulkan-x64.zip'}
  )){
    if(!(Test-Path -LiteralPath $opsDownload.Path)){
      Write-Output "Downloading official source: $($opsDownload.Url)"
      & curl.exe --fail --location --retry 2 --output $opsDownload.Path $opsDownload.Url
      if($LASTEXITCODE -ne 0){throw 'Download failed. Remove the incomplete named file before retrying.'}
    }
    Assert-OpsHash $opsDownload.Path $opsDownload.Hash
  }
  Expand-Archive -LiteralPath $opsArchive -DestinationPath $opsRuntime -Force
  Write-Output 'Official runtime and model installed; SHA256 verified. Run -Mode Start.'
  exit
}
if(Test-OpsModelServer){Write-Output 'notice-reader is already available at http://127.0.0.1:8089';exit}
if(Get-NetTCPConnection -LocalPort 8089 -State Listen -ErrorAction SilentlyContinue){throw 'Port 8089 is occupied by a different service. No process stopped.'}
Assert-OpsHash $opsModel $opsModelHash
Assert-OpsHash $opsArchive $opsArchiveHash
if(!(Test-Path -LiteralPath $opsServer)){throw 'Runtime executable missing. Run -Mode Install.'}
$opsArgs=@('-m',('"'+$opsModel+'"'),'--host','127.0.0.1','--port','8089','--alias','notice-reader','-c','8192','-np','1','-ngl','99','-t','6')
$opsProcess=Start-Process -FilePath $opsServer -ArgumentList $opsArgs -WorkingDirectory $opsRuntime -WindowStyle Hidden -RedirectStandardOutput (Join-Path $opsWork 'llama-notice.out.log') -RedirectStandardError (Join-Path $opsWork 'llama-notice.err.log') -PassThru
[IO.File]::WriteAllText($opsPidFile,[string]$opsProcess.Id)
for($opsAttempt=0;$opsAttempt -lt 25;$opsAttempt++){
  if(Test-OpsModelServer){Write-Output "Local notice model ready. PID $($opsProcess.Id), http://127.0.0.1:8089";exit}
  if($opsProcess.HasExited){throw 'Model server exited. Read work/llama-notice.err.log.'}
  Start-Sleep -Seconds 1
}
throw 'Model startup has not completed yet. Check -Mode Status and the runtime log.'
