import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";

interface PortfolioSyncMainStackProps extends cdk.StackProps {
  envName: string;
  artifactBucket: s3.IBucket;
  lambdaArtifactKey: string;
  backendArtifactKey: string;
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

    // Position Tracker tables (Phase 2)
    const snapshotsTable = new dynamodb.Table(this, "SnapshotsTable", {
      tableName: `portfolio-snapshots-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "platform_ts", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const transactionsTable = new dynamodb.Table(this, "TransactionsTable", {
      tableName: `portfolio-transactions-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "platform_ts_type", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Performance Chart tables (Phase 3)
    const dailyPricesTable = new dynamodb.Table(this, "DailyPricesTable", {
      tableName: `portfolio-daily-prices-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "symbol_date", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    dailyPricesTable.addGlobalSecondaryIndex({
      indexName: "date-index",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
    });

    // Fidelity raw statements (audit trail)
    const fidelityRawTable = new dynamodb.Table(this, "FidelityRawTable", {
      tableName: `fidelity-raw-statements-${props.envName}`,
      partitionKey: { name: "account_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "statement_month", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const buyLotsTable = new dynamodb.Table(this, "BuyLotsTable", {
      tableName: `portfolio-buy-lots-${props.envName}`,
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "symbol_ts", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Research: stock fundamentals (operating income, EPS, P/E by year)
    const fundamentalsTable = new dynamodb.Table(this, "FundamentalsTable", {
      tableName: `portfolio-fundamentals-${props.envName}`,
      partitionKey: { name: "symbol", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "year", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Earnings Dip Screener results
    const screenerTable = new dynamodb.Table(this, "ScreenerTable", {
      tableName: `portfolio-screener-${props.envName}`,
      partitionKey: { name: "market", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "symbol", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Index constituents (S&P 500, Nasdaq 100, Nifty 500)
    const indexConstituentsTable = new dynamodb.Table(this, "IndexConstituentsTable", {
      tableName: `portfolio-index-constituents-${props.envName}`,
      partitionKey: { name: "index_name", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "symbol", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
    // SAFETY: If no artifact key provided, keep existing Lambda code unchanged.
    // Only update code when explicitly deploying a new artifact.
    const ocrCode = props.lambdaArtifactKey
      ? lambda.Code.fromBucket(props.artifactBucket, props.lambdaArtifactKey)
      : lambda.Code.fromInline(
          '# PLACEHOLDER - deploy with -c lambdaArtifactKey=lambda/ocr-processor-<sha>.zip to update\ndef lambda_handler(event, context): return {"statusCode": 200}'
        );

    const ocrLambda = new lambda.Function(this, "OcrLambda", {
      functionName: `portfolio-ocr-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: ocrCode,
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

    // ==================== LAMBDA: DAILY PRICE CAPTURE ====================
    // SAFETY: Same pattern — only update code when artifact key provided
    const dailyPriceCode = props.backendArtifactKey
      ? lambda.Code.fromBucket(props.artifactBucket, props.backendArtifactKey)
      : lambda.Code.fromInline(
          '# PLACEHOLDER - deploy with -c backendArtifactKey=lambda/backend-api-<sha>.zip to update\ndef handler(event, context): return {"statusCode": 200, "body": "placeholder"}'
        );

    const dailyPriceLogGroup = new logs.LogGroup(this, "DailyPriceLogGroup", {
      logGroupName: `/aws/lambda/portfolio-daily-price-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dailyPriceLambda = new lambda.Function(this, "DailyPriceLambda", {
      functionName: `portfolio-daily-price-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "daily_price.handler",
      code: dailyPriceCode,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      logGroup: dailyPriceLogGroup,
      environment: {
        PORTFOLIO_TABLE: portfolioTable.tableName,
        DAILY_PRICES_TABLE: dailyPricesTable.tableName,
        ENV: props.envName,
      },
    });

    portfolioTable.grantReadData(dailyPriceLambda);
    dailyPricesTable.grantReadWriteData(dailyPriceLambda);

    // EventBridge: 8 PM EST Mon-Fri = 1:00 AM UTC Tue-Sat
    new events.Rule(this, "DailyPriceSchedule", {
      ruleName: `portfolio-daily-price-schedule-${props.envName}`,
      schedule: events.Schedule.expression("cron(0 1 ? * TUE-SAT *)"),
      targets: [new targets.LambdaFunction(dailyPriceLambda)],
    });

    // ==================== LAMBDA: EARNINGS SCREENER ====================
    const screenerLogGroup = new logs.LogGroup(this, "ScreenerLogGroup", {
      logGroupName: `/aws/lambda/portfolio-screener-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const screenerLambda = new lambda.Function(this, "ScreenerLambda", {
      functionName: `portfolio-screener-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "screener.handler",
      code: dailyPriceCode,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      logGroup: screenerLogGroup,
      environment: {
        SCREENER_TABLE: screenerTable.tableName,
        INDEX_CONSTITUENTS_TABLE: indexConstituentsTable.tableName,
        FUNDAMENTALS_TABLE: fundamentalsTable.tableName,
        ENV: props.envName,
      },
    });

    screenerTable.grantReadWriteData(screenerLambda);
    indexConstituentsTable.grantReadData(screenerLambda);
    fundamentalsTable.grantReadWriteData(screenerLambda);
    screenerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ["arn:aws:ssm:us-east-1:654654547262:parameter/portfolio/api-credentials"],
      })
    );

    // NOTE: Earnings Screener schedules REMOVED — Daily Scanner handles earnings dates now.
    // Screener Lambda kept for manual trigger only (refresh-indexes, etc.)

    // ==================== LAMBDA: DAILY STOCK SCANNER ====================
    // Replaces old MA Scanner. Stores ALL data (price, MAs, fundamentals) for all 1,100 stocks.
    const dailyScannerLogGroup = new logs.LogGroup(this, "DailyScannerLogGroup", {
      logGroupName: `/aws/lambda/portfolio-daily-scanner-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dailyScannerLambda = new lambda.Function(this, "DailyScannerLambda", {
      functionName: `portfolio-daily-scanner-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "daily_scanner.handler",
      code: dailyPriceCode,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(10),
      logGroup: dailyScannerLogGroup,
      environment: {
        SCREENER_TABLE: screenerTable.tableName,
        INDEX_CONSTITUENTS_TABLE: indexConstituentsTable.tableName,
        ENV: props.envName,
      },
    });

    screenerTable.grantReadWriteData(dailyScannerLambda);
    indexConstituentsTable.grantReadWriteData(dailyScannerLambda);
    dailyScannerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ["arn:aws:ssm:us-east-1:654654547262:parameter/portfolio/api-credentials"],
      })
    );

    // US: 8 PM EST = 1:00 AM UTC (Tue-Sat, covers Mon-Fri market close)
    new events.Rule(this, "DailyScannerUSSchedule", {
      ruleName: `portfolio-daily-scanner-us-schedule-${props.envName}`,
      schedule: events.Schedule.expression("cron(0 1 ? * TUE-SAT *)"),
      targets: [new targets.LambdaFunction(dailyScannerLambda, {
        event: events.RuleTargetInput.fromObject({ market: "US" }),
      })],
    });

    // India: 8 PM IST = 2:30 PM UTC (Mon-Fri)
    new events.Rule(this, "DailyScannerINSchedule", {
      ruleName: `portfolio-daily-scanner-in-schedule-${props.envName}`,
      schedule: events.Schedule.expression("cron(30 14 ? * MON-FRI *)"),
      targets: [new targets.LambdaFunction(dailyScannerLambda, {
        event: events.RuleTargetInput.fromObject({ market: "IN" }),
      })],
    });

    // ==================== LAMBDA: BACKEND API ====================
    // SAFETY: Same pattern — only update code when artifact key provided
    const apiCode = props.backendArtifactKey
      ? lambda.Code.fromBucket(props.artifactBucket, props.backendArtifactKey)
      : lambda.Code.fromInline(
          '# PLACEHOLDER - deploy with -c backendArtifactKey=lambda/backend-api-<sha>.zip to update\ndef handler(event, context): return {"statusCode": 200, "body": "placeholder"}'
        );

    const apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: `/aws/lambda/portfolio-api-${props.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiLambda = new lambda.Function(this, "ApiLambda", {
      functionName: `portfolio-api-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "app.handler",
      code: apiCode,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      logGroup: apiLogGroup,
      environment: {
        SCREENSHOTS_BUCKET: screenshotsBucket.bucketName,
        PORTFOLIO_TABLE: portfolioTable.tableName,
        UPLOADS_TABLE: uploadsTable.tableName,
        USERS_TABLE: usersTable.tableName,
        SYMBOL_MAP_TABLE: symbolMapTable.tableName,
        SHARES_TABLE: sharesTable.tableName,
        SNAPSHOTS_TABLE: snapshotsTable.tableName,
        TRANSACTIONS_TABLE: transactionsTable.tableName,
        DAILY_PRICES_TABLE: dailyPricesTable.tableName,
        BUY_LOTS_TABLE: buyLotsTable.tableName,
        FUNDAMENTALS_TABLE: fundamentalsTable.tableName,
        SCREENER_TABLE: screenerTable.tableName,
        INDEX_CONSTITUENTS_TABLE: indexConstituentsTable.tableName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        ENV: props.envName,
      },
    });

    screenshotsBucket.grantReadWrite(apiLambda);
    portfolioTable.grantReadWriteData(apiLambda);
    uploadsTable.grantReadWriteData(apiLambda);
    symbolMapTable.grantReadWriteData(apiLambda);
    sharesTable.grantReadWriteData(apiLambda);
    snapshotsTable.grantReadWriteData(apiLambda);
    transactionsTable.grantReadWriteData(apiLambda);
    dailyPricesTable.grantReadWriteData(apiLambda);
    buyLotsTable.grantReadWriteData(apiLambda);
    fundamentalsTable.grantReadWriteData(apiLambda);
    screenerTable.grantReadWriteData(apiLambda);
    indexConstituentsTable.grantReadWriteData(apiLambda);
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
        ],
        resources: ["*"],
      })
    );
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ["arn:aws:ssm:us-east-1:654654547262:parameter/portfolio/api-credentials"],
      })
    );
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [screenerLambda.functionArn, dailyScannerLambda.functionArn],
      })
    );

    // ==================== API GATEWAY ====================

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `portfolio-api-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["*"],
      },
    });

    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: new apigwv2int.HttpLambdaIntegration(
        "ApiIntegration",
        apiLambda
      ),
    });

    // ==================== FRONTEND: S3 + CLOUDFRONT ====================

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `portfolio-sync-web-654654547262-${props.envName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

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
    new cdk.CfnOutput(this, "SnapshotsTableName", {
      value: snapshotsTable.tableName,
    });
    new cdk.CfnOutput(this, "TransactionsTableName", {
      value: transactionsTable.tableName,
    });
    new cdk.CfnOutput(this, "DailyPricesTableName", {
      value: dailyPricesTable.tableName,
    });
    new cdk.CfnOutput(this, "BuyLotsTableName", {
      value: buyLotsTable.tableName,
    });
    new cdk.CfnOutput(this, "FidelityRawTableName", {
      value: fidelityRawTable.tableName,
    });
    new cdk.CfnOutput(this, "FundamentalsTableName", {
      value: fundamentalsTable.tableName,
    });
    new cdk.CfnOutput(this, "ScreenerTableName", {
      value: screenerTable.tableName,
    });
    new cdk.CfnOutput(this, "IndexConstituentsTableName", {
      value: indexConstituentsTable.tableName,
    });
    new cdk.CfnOutput(this, "DailyPriceLambdaName", {
      value: dailyPriceLambda.functionName,
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName,
    });
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution.distributionId,
    });
  }
}
