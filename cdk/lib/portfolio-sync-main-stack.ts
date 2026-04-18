import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface PortfolioSyncMainStackProps extends cdk.StackProps {
  envName: string;
  artifactBucket: s3.IBucket;
  lambdaArtifactKey: string;
}

export class PortfolioSyncMainStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: PortfolioSyncMainStackProps
  ) {
    super(scope, id, props);

    // --- S3: Screenshots bucket (uploads only) ---
    const screenshotsBucket = new s3.Bucket(this, "ScreenshotsBucket", {
      bucketName: `portfolio-screenshots-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    // --- DynamoDB: Users table ---
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: `portfolio-users-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    usersTable.addGlobalSecondaryIndex({
      indexName: "email-index",
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
    });

    // --- DynamoDB: Portfolio (holdings) table ---
    const portfolioTable = new dynamodb.Table(this, "PortfolioTable", {
      tableName: `portfolio-holdings-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "symbol", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- DynamoDB: Uploads table ---
    const uploadsTable = new dynamodb.Table(this, "UploadsTable", {
      tableName: `portfolio-uploads-${props.envName}`,
      partitionKey: { name: "upload_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    uploadsTable.addGlobalSecondaryIndex({
      indexName: "user-index",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
    });

    // --- SQS: Dead letter queue ---
    const dlq = new sqs.Queue(this, "OcrDLQ", {
      queueName: `portfolio-ocr-dlq-${props.envName}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- CloudWatch: Log group ---
    const logGroup = new logs.LogGroup(this, "OcrLogGroup", {
      logGroupName: `/aws/lambda/portfolio-ocr-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Lambda: OCR processor ---
    const ocrLambda = new lambda.Function(this, "OcrLambda", {
      functionName: `portfolio-ocr-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: props.lambdaArtifactKey
        ? lambda.Code.fromBucket(props.artifactBucket, props.lambdaArtifactKey)
        : lambda.Code.fromInline(
            'def lambda_handler(event, context): return {"statusCode": 200, "body": "placeholder"}'
          ),
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      deadLetterQueue: dlq,
      logGroup: logGroup,
      environment: {
        SCREENSHOTS_BUCKET: screenshotsBucket.bucketName,
        PORTFOLIO_TABLE: portfolioTable.tableName,
        UPLOADS_TABLE: uploadsTable.tableName,
        USERS_TABLE: usersTable.tableName,
        ENV: props.envName,
      },
    });

    // --- IAM: Grant permissions ---
    screenshotsBucket.grantRead(ocrLambda);
    portfolioTable.grantReadWriteData(ocrLambda);
    uploadsTable.grantReadWriteData(ocrLambda);

    // --- S3 event trigger: uploads/ prefix → Lambda ---
    screenshotsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ocrLambda),
      { prefix: "uploads/" }
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, "ScreenshotsBucketName", {
      value: screenshotsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "OcrLambdaName", {
      value: ocrLambda.functionName,
    });
    new cdk.CfnOutput(this, "PortfolioTableName", {
      value: portfolioTable.tableName,
    });
    new cdk.CfnOutput(this, "UsersTableName", {
      value: usersTable.tableName,
    });
    new cdk.CfnOutput(this, "UploadsTableName", {
      value: uploadsTable.tableName,
    });
  }
}
