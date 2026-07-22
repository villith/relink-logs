# Signs one file with Azure Artifact Signing. Invoked by the Tauri bundler
# through bundle.windows.signCommand, which is set ONLY in the CI overlay
# config (.tauri-release-config.json) — local builds never sign and never run
# this.
#
# Must run under pwsh (PowerShell 7) — the TrustedSigning module is installed
# into PS7 module paths (usually by the azure/trusted-signing-action step that
# signs hook.dll; this script installs it itself if missing). Windows
# PowerShell 5.1 cannot see it. Env vars required:
#   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET  (EnvironmentCredential)
#   AZURE_SIGNING_ENDPOINT / AZURE_SIGNING_ACCOUNT / AZURE_CERT_PROFILE
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command Invoke-TrustedSigning -ErrorAction SilentlyContinue)) {
    Write-Host "ci-sign: TrustedSigning module not found, installing"
    Install-Module TrustedSigning -Force -Scope CurrentUser -Repository PSGallery
}

Write-Host "ci-sign: signing $File"
Invoke-TrustedSigning `
    -Endpoint $env:AZURE_SIGNING_ENDPOINT `
    -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT `
    -CertificateProfileName $env:AZURE_CERT_PROFILE `
    -Files $File `
    -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
    -TimestampDigest SHA256

$sig = Get-AuthenticodeSignature $File
if ($sig.Status -ne 'Valid') {
    throw "ci-sign: $File is not validly signed after Invoke-TrustedSigning (status: $($sig.Status))"
}
Write-Host "ci-sign: $File -> $($sig.Status) ($($sig.SignerCertificate.Subject))"
