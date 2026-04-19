import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
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

    // --- Cognito: User Pool ---
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `portfolio-sync-users-${props.envName}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `portfolio-sync-web-${props.envName}`,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["http://localhost:3000/callback"],
        logoutUrls: ["http://localhost:3000/"],
      },
    });

    userPool.addDomain("CognitoDomain", {
      cognitoDomain: { domainPrefix: `portfolio-sync-${props.envName}` },
    });

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

    // --- DynamoDB: Symbol map table (admin-managed lookup) ---
    const symbolMapTable = new dynamodb.Table(this, "SymbolMapTable", {
      tableName: `portfolio-symbol-map-${props.envName}`,
      partitionKey: { name: "stock_name", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
        SYMBOL_MAP_TABLE: symbolMapTable.tableName,
        ENV: props.envName,
      },
    });

    // --- IAM: Grant permissions ---
    screenshotsBucket.grantRead(ocrLambda);
    portfolioTable.grantReadWriteData(ocrLambda);
    uploadsTable.grantReadWriteData(ocrLambda);
    symbolMapTable.grantReadData(ocrLambda);
    ocrLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["textract:DetectDocumentText"],
        resources: ["*"],
      })
    );

    // --- S3 event trigger: uploads/ prefix → Lambda ---
    screenshotsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ocrLambda),
      { prefix: "uploads/" }
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "CognitoClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: `portfolio-sync-${props.envName}.auth.${this.region}.amazoncognito.com`,
    });
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
    new cdk.CfnOutput(this, "SymbolMapTableName", {
      value: symbolMapTable.tableName,
    });
    new cdk.CfnOutput(this, "UploadsTableName", {
      value: uploadsTable.tableName,
    });
  }
}
