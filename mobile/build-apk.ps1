# Compila el APK de Kava y lo deja en frontend/public/descargar/kava.apk,
# que es lo que sirve la pagina /descargar.
# Requiere JDK 21 y el Android SDK en %LOCALAPPDATA%\Android\Sdk.
$ErrorActionPreference = 'Stop'
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' | Select-Object -First 1
if ($jdk) { $env:JAVA_HOME = $jdk.FullName }

Push-Location $PSScriptRoot
try {
  npx cap sync android
  Push-Location android
  try { .\gradlew.bat assembleDebug --no-daemon } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'Fallo la compilacion del APK' }
  $destino = Join-Path $PSScriptRoot '..\frontend\public\descargar\kava.apk'
  Copy-Item 'android\app\build\outputs\apk\debug\app-debug.apk' $destino -Force
  Write-Host "APK copiado a $destino"
} finally {
  Pop-Location
}
