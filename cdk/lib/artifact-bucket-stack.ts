import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

interface ArtifactBucketStackProps extends cdk.StackProps {
  envName: string;
}

export class ArtifactBucketStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ArtifactBucketStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "ArtifactBucket", {
      bucketName: `portfolio-sync-artifacts-${props.envName}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    new cdk.CfnOutput(this, "ArtifactBucketName", {
      value: this.bucket.bucketName,
    });
  }
}
