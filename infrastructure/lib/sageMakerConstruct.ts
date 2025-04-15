// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { CfnOutput, Stack } from 'aws-cdk-lib';

export interface SageMakerConstructProps {
    readonly dataBucket: s3.Bucket;
}

/**
 * The CDK Construct provisions the sagemaker execution related resources.
 */
export class SageMakerConstruct extends Construct {
    readonly sagemakerExecutionRole: iam.Role;
    readonly sagemakerArtifactBucket: s3.Bucket;
    readonly modelApprovalTopic: sns.Topic;
    readonly modelApprovalPipeline: sagemaker.CfnPipeline;

    constructor(scope: Construct, id: string, props: SageMakerConstructProps) {
        super(scope, id);

        this.sagemakerArtifactBucket = new s3.Bucket(this, 'SageMakerArtifactBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        this.sagemakerExecutionRole = new iam.Role(this, 'SageMakerExecutionRole', {
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')],
        });

        this.sagemakerExecutionRole.addToPolicy(
            iam.PolicyStatement.fromJson({
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:ListBucket'],
                Resource: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
            })
        );

        this.sagemakerExecutionRole.addToPolicy(
            iam.PolicyStatement.fromJson({
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
                Resource: [this.sagemakerArtifactBucket.bucketArn, `${this.sagemakerArtifactBucket.bucketArn}/*`],
            })
        );

        // Create SNS topic for model approval notifications
        this.modelApprovalTopic = new sns.Topic(this, 'ModelApprovalTopic', {
            displayName: 'Model Approval Notifications',
        });

        // Create a simple SageMaker pipeline with just an approval step
        this.modelApprovalPipeline = new sagemaker.CfnPipeline(this, 'ModelApprovalPipeline', {
            pipelineName: 'model-approval-pipeline',
            pipelineDefinition: {
                PipelineDefinitionBody: JSON.stringify({
                    Version: '2020-12-01',
                    Steps: [
                        {
                            Name: 'ModelApprovalStep',
                            Type: 'Callback',
                            CallbackConfig: {
                                OutputPath: `s3://${this.sagemakerArtifactBucket.bucketName}/pipeline-outputs/approval-output/`,
                            },
                        },
                    ],
                }),
            },
            roleArn: this.sagemakerExecutionRole.roleArn,
        });

        // Create EventBridge rule to trigger when a model is registered
        const modelRegistryRule = new events.Rule(this, 'ModelRegistryRule', {
            eventPattern: {
                source: ['aws.sagemaker'],
                detailType: ['SageMaker Model Package State Change'],
                detail: {
                    ModelApprovalStatus: ['PendingManualApproval', 'Approved'],
                },
            },
            description: 'Rule to trigger when a model is registered in the SageMaker Model Registry',
        });

        // Get the current stack
        const stack = Stack.of(this);

        // Create a Lambda function to start the SageMaker pipeline
        const pipelineStarterFunction = new lambda.Function(this, 'PipelineStarterFunction', {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
                const AWS = require('aws-sdk');
                const sagemaker = new AWS.SageMaker();
                
                exports.handler = async (event) => {
                    console.log('Event received:', JSON.stringify(event, null, 2));
                    
                    try {
                        // Extract model package details from the event
                        const modelPackageArn = event.detail.ModelPackageArn;
                        const modelPackageGroupName = event.detail.ModelPackageGroupName;
                        const modelApprovalStatus = event.detail.ModelApprovalStatus;
                        
                        console.log(\`Starting pipeline for model: \${modelPackageGroupName}, status: \${modelApprovalStatus}\`);
                        
                        // Start the SageMaker pipeline
                        const startPipelineResponse = await sagemaker.startPipelineExecution({
                            PipelineName: 'model-approval-pipeline',
                            PipelineParameters: [
                                {
                                    Name: 'ModelPackageArn',
                                    Value: modelPackageArn
                                },
                                {
                                    Name: 'ModelApprovalStatus',
                                    Value: modelApprovalStatus
                                }
                            ]
                        }).promise();
                        
                        console.log('Pipeline started:', startPipelineResponse);
                        return {
                            statusCode: 200,
                            body: JSON.stringify('Pipeline started successfully'),
                        };
                    } catch (error) {
                        console.error('Error starting pipeline:', error);
                        throw error;
                    }
                };
            `),
        });

        // Grant the Lambda function permission to start the SageMaker pipeline
        pipelineStarterFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['sagemaker:StartPipelineExecution', 'sagemaker:DescribePipelineExecution'],
                resources: [`arn:aws:sagemaker:${stack.region}:${stack.account}:pipeline/model-approval-pipeline`],
            })
        );

        // Add the Lambda function as a target for the EventBridge rule
        modelRegistryRule.addTarget(new targets.LambdaFunction(pipelineStarterFunction));

        // Add SNS topic as a target for the EventBridge rule
        modelRegistryRule.addTarget(new targets.SnsTopic(this.modelApprovalTopic));

        // Output the SNS topic ARN
        new CfnOutput(this, 'ModelApprovalTopicArn', {
            value: this.modelApprovalTopic.topicArn,
            description: 'ARN of the SNS topic for model approval notifications',
            exportName: 'ModelApprovalTopicArn',
        });

        // Output the pipeline name
        new CfnOutput(this, 'ModelApprovalPipelineName', {
            value: 'model-approval-pipeline',
            description: 'Name of the SageMaker pipeline for model approval',
            exportName: 'ModelApprovalPipelineName',
        });
    }
}
