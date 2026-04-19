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
  adminEmail: string;
}

export class PortfolioSyncMainStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: PortfolioSyncMainStackProps
  ) {
    super(scope, id, props);

    // ==================== COGNITO ====================

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
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true, minLen: 1, maxLen: 20 }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Admin group
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
      description: "Administrators with access to symbol management",
    });

    // Post-confirmation Lambda: auto-assign custom:role based on email
    const postConfirmLambda = new lambda.Function(this, "PostConfirmLambda", {
      functionName: `portfolio-post-confirm-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
import boto3
import os

cognito_client = boto3.client("cognito-idp")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")

def handler(event, context):
    email = event["request"]["userAttributes"].get("email", "")
    username = event["userName"]
    pool_id = event["userPoolId"]
    role = "admin" if email.lower() == ADMIN_EMAIL.lower() else "user"

    cognito_client.admin_update_user_attributes(
        UserPoolId=pool_id,
        Username=username,
        UserAttributes=[{"Name": "custom:role", "Value": role}],
    )

    if role == "admin":
        cognito_client.admin_add_user_to_group(
            UserPoolId=pool_id,
            Username=username,
            GroupName="admin",
        )

    return event
`),
      environment: {
        ADMIN_EMAIL: props.adminEmail,
      },
      timeout: cdk.Duration.seconds(10),
    });

    postConfirmLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminAddUserToGroup",
        ],
        resources: ["*"],
      })
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      postConfirmLambda
    );

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `portfolio-sync-web-${props.envName}`,
      authFlows: { userPassword: true, userSrp: true },
      readAttributes: new cognito.ClientAttributes().withCustomAttributes("role"),
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ["http://localhost:3000/callback"],
        logoutUrls: ["http://localhost:3000/"],
      },
    });

    userPool.addDomain("CognitoDomain", {
      cognitoDomain: { domainPrefix: `portfolio-sync-${props.envName}` },
    });

    // ==================== S3 ====================

    const screenshotsBucket = new s3.Bucket(this, "ScreenshotsBucket", {
      bucketName: `portfolio-screenshots-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    // ==================== DYNAMODB ====================

    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: `portfolio-users-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    usersTable.addGlobalSecondaryIndex({
      indexName: "email-index",
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
    });

    const portfolioTable = new dynamodb.Table(this, "PortfolioTable", {
      tableName: `portfolio-holdings-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "stock_name", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    portfolioTable.addGlobalSecondaryIndex({
      indexName: "symbol-index",
      partitionKey: { name: "symbol", type: dynamodb.AttributeType.STRING },
    });

    const uploadsTable = new dynamodb.Table(this, "UploadsTable", {
      tableName: `portfolio-uploads-${props.envName}`,
      partitionKey: {
        name: "upload_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    uploadsTable.addGlobalSecondaryIndex({
      indexName: "user-index",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
    });

    const symbolMapTable = new dynamodb.Table(this, "SymbolMapTable", {
      tableName: `portfolio-symbol-map-${props.envName}`,
      partitionKey: {
        name: "stock_name",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Shares table: tracks dashboard sharing between users
    // PK=owner_id, SK=viewer_id
    // status: pending_admin | pending_viewer | approved | rejected
    const sharesTable = new dynamodb.Table(this, "SharesTable", {
      tableName: `portfolio-shares-${props.envName}`,
      partitionKey: { name: "owner_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "viewer_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    sharesTable.addGlobalSecondaryIndex({
      indexName: "viewer-index",
      partitionKey: { name: "viewer_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
    });
    sharesTable.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
    });

    // ==================== SQS + CLOUDWATCH ====================

    const dlq = new sqs.Queue(this, "OcrDLQ", {
      queueName: `portfolio-ocr-dlq-${props.envName}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const logGroup = new logs.LogGroup(this, "OcrLogGroup", {
      logGroupName: `/aws/lambda/portfolio-ocr-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==================== LAMBDA: OCR ====================

    const ocrLambda = new lambda.Function(this, "OcrLambda", {
      functionName: `portfolio-ocr-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: props.lambdaArtifactKey
        ? lambda.Code.fromBucket(props.artifactBucket, props.lambdaArtifactKey)
        : lambda.Code.fromInline(
            'def lambda_handler(event, context): return {"statusCode": 200}'
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

    screenshotsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ocrLambda),
      { prefix: "uploads/" }
    );

    // ==================== OUTPUTS ====================

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
    new cdk.CfnOutput(this, "SharesTableName", {
      value: sharesTable.tableName,
    });
    new cdk.CfnOutput(this, "UploadsTableName", {
      value: uploadsTable.tableName,
    });
  }
}
