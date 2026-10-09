$ErrorActionPreference = 'Stop'
$opsBundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$opsCandidates = @($opsBundledNode)
$opsNodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($opsNodeCommand) { $opsCandidates += $opsNodeCommand.Source }
foreach ($opsCandidate in $opsCandidates) {
  if (!(Test-Path -LiteralPath $opsCandidate)) { continue }
  $opsVersion = & $opsCandidate -p 'process.versions.node'
  if ([version]$opsVersion -ge [version]'24.19.0' -and [version]$opsVersion -lt [version]'25.0.0') { $opsNodePath = $opsCandidate; break }
}
if (!$opsNodePath) { throw 'Node.js 24.19 이상(24.x)이 필요합니다. 설치한 뒤 다시 실행하세요.' }
Set-Location -LiteralPath $PSScriptRoot
& $opsNodePath server.mjs
