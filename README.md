# portfolio-screenshot-sync-cdk

AWS CDK infrastructure for the Portfolio Screenshot Sync platform.

## Stacks

| Stack | Resources |
|-------|-----------|
| `ArtifactBucketStack-{env}` | S3 artifact bucket for Lambda zips |
| `PortfolioSyncMainStack-{env}` | S3 (screenshots), Lambda (OCR), DynamoDB ×3, SQS DLQ, CloudWatch |

## Deploy

```bash
cd cdk
npm install
cdk bootstrap aws://654654547262/us-west-1

# 1. Artifact bucket (one-time)
cdk deploy ArtifactBucketStack-dev -c env=dev

# 2. Main stack (after Lambda zip is uploaded)
cdk deploy PortfolioSyncMainStack-dev -c env=dev \
  -c lambdaArtifactKey=lambda/ocr-processor-<git-sha>.zip
```

## Related

- App repo: [portfolio-screenshot-sync](https://github.com/aburmd/portfolio-screenshot-sync)
