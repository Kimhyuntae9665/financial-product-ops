param([string]$JobRoot='C:/CodexResourceShare/jobs/finance-agent-20261010',[int]$Port=8096,[int]$Threads=4,[int]$GpuLayers=0,[ValidateSet(4096,8192)][int]$ContextSize=8192)
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'remote-model.mjs') $JobRoot $Port $Threads $GpuLayers $ContextSize
exit $LASTEXITCODE
