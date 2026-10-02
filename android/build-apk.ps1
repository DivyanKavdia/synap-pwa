<#
    Builds the Synap Android APK on Windows WITHOUT Android Studio.

    Everything lands under %USERPROFILE%\.synap-build so nothing else on the
    machine is touched, and the finished APK is copied to your Downloads folder.

    Run it in PowerShell from the folder that contains this script:

        powershell -ExecutionPolicy Bypass -File .\build-apk.ps1

    First run downloads roughly 700 MB (JDK + Android SDK + Gradle) and takes
    5-15 minutes depending on your connection. Later runs reuse all of it and
    finish in well under a minute.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'   # download progress bars are very slow in PS 5

$Root      = Join-Path $env:USERPROFILE '.synap-build'
$SdkRoot   = Join-Path $Root 'android-sdk'
$Project   = Join-Path $PSScriptRoot '.'
$Downloads = Join-Path $env:USERPROFILE 'Downloads'

$JdkUrl    = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_windows_hotspot_17.0.13_11.zip'
$ToolsUrl  = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$GradleUrl = 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

function Get-Archive($url, $zipPath, $destination, $marker) {
    if (Test-Path $marker) {
        Write-Host "    already present, skipping"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $zipPath) | Out-Null
    if (-not (Test-Path $zipPath)) {
        Write-Host "    downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    }
    Write-Host "    extracting"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $destination -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $Project 'settings.gradle.kts'))) {
    throw "Run this from inside the synap-android folder (settings.gradle.kts not found here)."
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null

# ---------------------------------------------------------------------- JDK 17
Step 'Java 17'
$JdkHome = Get-ChildItem -Path (Join-Path $Root 'jdk') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $JdkHome) {
    Get-Archive $JdkUrl (Join-Path $Root 'jdk.zip') (Join-Path $Root 'jdk') 'no-marker'
    $JdkHome = Get-ChildItem -Path (Join-Path $Root 'jdk') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $JdkHome) { throw "Could not locate a JDK under $Root\jdk" }
$env:JAVA_HOME = $JdkHome
$env:PATH      = "$JdkHome\bin;$env:PATH"
Write-Host "    JAVA_HOME = $JdkHome"

# -------------------------------------------------------- Android commandline
Step 'Android SDK command-line tools'
$CmdlineBin = Join-Path $SdkRoot 'cmdline-tools\latest\bin'
if (-not (Test-Path (Join-Path $CmdlineBin 'sdkmanager.bat'))) {
    $staging = Join-Path $Root 'cmdline-staging'
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    Get-Archive $ToolsUrl (Join-Path $Root 'cmdline-tools.zip') $staging 'no-marker'
    # The zip contains cmdline-tools\; sdkmanager insists on living in
    # cmdline-tools\latest\, otherwise it refuses to resolve the SDK root.
    New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot 'cmdline-tools') | Out-Null
    Move-Item (Join-Path $staging 'cmdline-tools') (Join-Path $SdkRoot 'cmdline-tools\latest') -Force
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
$env:ANDROID_HOME     = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:PATH             = "$CmdlineBin;$env:PATH"

Step 'SDK platform 35 and build-tools (accepting licences)'
$sdkmanager = Join-Path $CmdlineBin 'sdkmanager.bat'
# 'y' repeated is how sdkmanager expects licence acceptance on stdin.
$yes = ("y`n" * 60)
$yes | & $sdkmanager --sdk_root="$SdkRoot" --licenses            | Out-Null
$yes | & $sdkmanager --sdk_root="$SdkRoot" "platform-tools" "platforms;android-35" "build-tools;35.0.0" | Out-Null

# --------------------------------------------------------------------- Gradle
Step 'Gradle'
$GradleBin = Get-ChildItem -Path (Join-Path $Root 'gradle') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\gradle.bat') } |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $GradleBin) {
    Get-Archive $GradleUrl (Join-Path $Root 'gradle.zip') (Join-Path $Root 'gradle') 'no-marker'
    $GradleBin = Get-ChildItem -Path (Join-Path $Root 'gradle') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\gradle.bat') } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $GradleBin) { throw "Could not locate Gradle under $Root\gradle" }

# ---------------------------------------------------------------------- build
Step 'Building the APK'
Push-Location $Project
try {
    & (Join-Path $GradleBin 'bin\gradle.bat') --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$apk = Join-Path $Project 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) { throw "Build reported success but no APK at $apk" }

$target = Join-Path $Downloads 'synap-debug.apk'
Copy-Item $apk $target -Force

Write-Host "`nDone." -ForegroundColor Green
Write-Host "APK: $target"
Write-Host ""
Write-Host "To install it, either:"
Write-Host "  - copy synap-debug.apk to the phone and open it (allow 'install unknown apps'), or"
Write-Host "  - with USB debugging on:  adb install -r `"$target`""
