import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

async function diag() {
    const region = (process.env.S3_REGION || "").trim();
    const bucket = (process.env.S3_BUCKET_PDF || "").trim();

    console.log(`--- DIAGNOSTIC S3 ---`);
    console.log(`Region cible : ${region}`);
    console.log(`Bucket cible : ${bucket}`);

    const client = new S3Client({
        region: region,
        credentials: {
            accessKeyId: (process.env.S3_ACCESS_KEY_ID || "").trim(),
            secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY || "").trim(),
        }
    });

    try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
        console.log("✅ SUCCÈS : La connexion S3 est parfaite. Les clés et la région sont BONNES.");
    } catch (err: any) {
        console.error("❌ ÉCHEC : AWS a rejeté la connexion.");
        console.error(`Code : ${err.name}`);
        console.error(`Message : ${err.message}`);
    }
}
diag();
