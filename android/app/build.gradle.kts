plugins {
    id("com.android.application")
}

android {
    namespace = "com.traai.chat"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.traai.chat"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // Passed from the GitHub Action: gradle assembleDebug -PsiteUrl=https://your-site.vercel.app/
        val url = (project.findProperty("siteUrl") as String?) ?: "https://example.com/"
        buildConfigField("String", "SITE_URL", "\"$url\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
