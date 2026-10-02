plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.synap.pendant"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.synap.pendant"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // The live PWA origin. The backend CORS allowlist and the Google OAuth
        // client are both registered against this exact origin, so the WebView
        // must load it rather than bundled assets.
        buildConfigField("String", "PWA_ORIGIN", "\"https://divyankavdia.github.io\"")
        buildConfigField("String", "PWA_START_URL", "\"https://divyankavdia.github.io/synap-pwa/\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // WebViewCompat.addDocumentStartJavaScript + WebViewAssetLoader
    implementation("androidx.webkit:webkit:1.12.1")
    // Chrome Custom Tabs: Google Sign-In is blocked inside WebViews, so the
    // existing pairing flow hands the login off to real Chrome.
    implementation("androidx.browser:browser:1.8.0")
}
