plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val versionCounterFile = file("version-counter.txt")

// La version de l'APK doit rester alignée sur celle de l'interface web (APP_VERSION
// dans api/server.js). Le compteur n'est donc PAS incrémenté automatiquement : on le
// règle à la main, en même temps que la version web.
fun currentBuildNumber(): Int {
    return versionCounterFile.readText().trim().toIntOrNull() ?: 1
}

android {
    namespace = "com.example.smsgateway"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.smsgateway"
        minSdk = 26
        targetSdk = 35
        val buildNumber = currentBuildNumber()
        versionCode = buildNumber
        versionName = "1.$buildNumber"
    }

    buildTypes {
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

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
