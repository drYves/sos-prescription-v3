import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

async function diag() {
    console.log(`--- DIAGNOSTIC S3 BRUT ---`);
    const client = new S3Client({
        region: (process.env.S3_REGION || "").trim(),
        credentials: {
            accessKeyId: (process.env.S3_ACCESS_KEY_ID || "").trim(),
            secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY || "").trim(),
        }
    });
    try {
        await client.send(new ListObjectsV2Command({ Bucket: (process.env.S3_BUCKET_PDF || "").trim(), MaxKeys: 1 }));
        console.log("✅ SUCCÈS : Les identifiants S3 sont valides.");
    } catch (err: any) {
        console.error("❌ ÉCHEC : AWS a rejeté la connexion.");
        console.error(`Erreur : [${err.name}] ${err.message}`);
    }
}
diag();
