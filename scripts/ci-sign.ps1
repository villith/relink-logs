# Signs one file with Azure Artifact Signing. Invoked by the Tauri bundler
# through bundle.windows.signCommand, which is set ONLY in the CI overlay
# config (.tauri-release-config.json) — local builds never sign and never run
# this.
#
# Requires the TrustedSigning PowerShell module — already present because the
# azure/trusted-signing-action step that signs hook.dll runs before the build
# and installs it — plus these env vars:
#   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET  (EnvironmentCredential)
#   AZURE_SIGNING_ENDPOINT / AZURE_SIGNING_ACCOUNT / AZURE_CERT_PROFILE
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

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
