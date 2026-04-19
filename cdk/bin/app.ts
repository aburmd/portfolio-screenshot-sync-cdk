#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ArtifactBucketStack } from "../lib/artifact-bucket-stack";
import { PortfolioSyncMainStack } from "../lib/portfolio-sync-main-stack";

const app = new cdk.App();
const env = app.node.tryGetContext("env") || "dev";
const awsEnv = { account: "654654547262", region: "us-west-1" };

const artifactStack = new ArtifactBucketStack(
  app,
  `ArtifactBucketStack-${env}`,
  { env: awsEnv, envName: env }
);

new PortfolioSyncMainStack(app, `PortfolioSyncMainStack-${env}`, {
  env: awsEnv,
  envName: env,
  artifactBucket: artifactStack.bucket,
  lambdaArtifactKey: app.node.tryGetContext("lambdaArtifactKey") || "",
  backendArtifactKey: app.node.tryGetContext("backendArtifactKey") || "",
  adminEmail: app.node.tryGetContext("adminEmail") || "aburmd@gmail.com",
});
