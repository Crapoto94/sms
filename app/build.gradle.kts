plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val versionCounterFile = file("version-counter.txt")

// versionCode : entier technique Android, doit toujours augmenter (issu du
// compteur ci-dessous). versionName : version affichée à l'utilisateur
// (majeur.mineur.patch), fixée à la main ci-dessous à chaque publication.
// Les deux doivent rester alignés sur la version de l'interface web
// (APP_VERSION dans api/server.js) : on les règle à la main ensemble.
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
        versionCode = currentBuildNumber()
        versionName = "1.4.2"
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
