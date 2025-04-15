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
    readonly projectName?: string;
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

        // Use provided project name or default to 'mlops-e2e'
        const projectName = props.projectName || 'mlops-e2e';
        const modelPackageGroupName = 'AbaloneModelPackageGroup';

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

        // Create a SageMaker pipeline with training and manual approval steps
        this.modelApprovalPipeline = new sagemaker.CfnPipeline(this, 'ModelApprovalPipeline', {
            pipelineName: 'model-approval-pipeline',
            pipelineDefinition: {
                PipelineDefinitionBody: JSON.stringify({
                    Version: '2020-12-01',
                    Steps: [
                        {
                            Name: 'TrainingStep',
                            Type: 'Training',
                            Arguments: {
                                AlgorithmSpecification: {
                                    TrainingImage:
                                        '683313688378.dkr.ecr.ca-central-1.amazonaws.com/sagemaker-xgboost:1.0-1',
                                    TrainingInputMode: 'File',
                                },
                                InputDataConfig: [
                                    {
                                        ChannelName: 'train',
                                        DataSource: {
                                            S3DataSource: {
                                                S3Uri: `s3://${this.sagemakerArtifactBucket.bucketName}/data/train`,
                                                S3DataType: 'S3Prefix',
                                                S3DataDistributionType: 'FullyReplicated',
                                            },
                                        },
                                        ContentType: 'text/csv',
                                    },
                                ],
                                OutputDataConfig: {
                                    S3OutputPath: `s3://${this.sagemakerArtifactBucket.bucketName}/output`,
                                },
                                ResourceConfig: {
                                    InstanceType: 'ml.m5.large',
                                    InstanceCount: 1,
                                    VolumeSizeInGB: 10,
                                },
                                StoppingCondition: {
                                    MaxRuntimeInSeconds: 3600,
                                },
                            },
                        },
                        {
                            Name: 'ManualApprovalStep',
                            Type: 'Approval',
                            Description: 'Manual approval step for the model',
                            DependsOn: ['TrainingStep'],
                        },
                    ],
                }),
            },
            roleArn: this.sagemakerExecutionRole.roleArn,
        });

        // Get the current stack
        const stack = Stack.of(this);

        // Create EventBridge rule to trigger when a model is registered in the model registry
        const modelRegistryRule = new events.Rule(this, 'ModelRegistryRule', {
            eventPattern: {
                source: ['aws.sagemaker'],
                detailType: ['SageMaker Model Package State Change'],
                detail: {
                    ModelPackageGroupName: [modelPackageGroupName],
                },
            },
            description: 'Rule to trigger when a model is registered in the SageMaker Model Registry',
        });

        // Create a Lambda function to handle model registry events and trigger the SageMaker pipeline
        const modelRegistryHandler = new lambda.Function(this, 'ModelRegistryHandler', {
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
                        const modelApprovalStatus = event.detail.ModelApprovalStatus;
                        
                        console.log(\`Model package \${modelPackageArn} has status: \${modelApprovalStatus}\`);
                        
                        // Get the project name from environment variable
                        const projectName = process.env.PROJECT_NAME;
                        
                        // Start the SageMaker pipeline with the model package ARN
                        const startPipelineResponse = await sagemaker.startPipelineExecution({
                            PipelineName: projectName,
                            PipelineParameters: [
                                {
                                    Name: 'ModelApprovalStatus',
                                    Value: 'Approved'
                                }
                            ]
                        }).promise();
                        
                        console.log(\`Pipeline \${projectName} started: \${startPipelineResponse.PipelineExecutionArn}\`);
                        return {
                            statusCode: 200,
                            body: JSON.stringify('Pipeline execution started successfully')
                        };
                    } catch (error) {
                        console.error('Error starting pipeline:', error);
                        throw error;
                    }
                };
            `),
            environment: {
                PROJECT_NAME: projectName,
            },
        });

        // Grant the Lambda function permission to start the SageMaker pipeline
        modelRegistryHandler.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'sagemaker:StartPipelineExecution',
                    'sagemaker:DescribePipelineExecution',
                    'sagemaker:DescribePipeline',
                ],
                resources: [
                    `arn:aws:sagemaker:${stack.region}:${stack.account}:pipeline/${projectName}`,
                    `arn:aws:sagemaker:${stack.region}:${stack.account}:pipeline/${projectName}/*`,
                ],
            })
        );

        // Add the Lambda function as a target for the EventBridge rule
        modelRegistryRule.addTarget(new targets.LambdaFunction(modelRegistryHandler));

        // Add SNS topic as a target for the EventBridge rule for notifications
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
