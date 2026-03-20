import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

async function diag() {
    console.log(`--- DIAGNOSTIC S3 BRUT (VPS MODE) ---`);
    
    const config = {
        region: (process.env.S3_REGION || "").trim(),
        bucket: (process.env.S3_BUCKET_PDF || "").trim(),
        accessKeyId: (process.env.S3_ACCESS_KEY_ID || "").trim(),
        secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY || "").trim()
    };

    console.log(`Region : ${config.region}`);
    console.log(`Bucket : ${config.bucket}`);
    console.log(`Access Key (début) : ${config.accessKeyId.substring(0, 5)}...`);

    const client = new S3Client({
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        }
    });

    try {
        await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
        console.log("✅ SUCCÈS : Les identifiants S3 sont valides. La serrure accepte la clé.");
    } catch (err: any) {
        console.error("❌ ÉCHEC : AWS rejette la connexion.");
        console.error(`Erreur : [${err.name}] ${err.message}`);
    }
}
diag();
