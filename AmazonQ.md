# Model Registry Event Trigger Implementation

This document describes the changes made to implement an event trigger when a new model is pushed to the SageMaker Model Registry.

## Changes Made

1. Updated `sageMakerConstruct.ts` to:
   - Add a projectName parameter to the SageMakerConstructProps interface
   - Create an EventBridge rule that triggers when a model is registered in the model registry
   - Create a Lambda function that starts the SageMaker pipeline when a model is registered
   - Configure the Lambda function with appropriate permissions to start the pipeline

2. Updated `infrastractureStack.ts` to:
   - Pass the projectName to the SageMakerConstruct

## How It Works

1. When a new model is registered in the SageMaker Model Registry, an EventBridge event is generated
2. The EventBridge rule detects this event and triggers the Lambda function
3. The Lambda function extracts the model package details and starts the SageMaker pipeline
4. The SageMaker pipeline includes a manual approval step before deploying the model

## Testing

To test this implementation:
1. Deploy the changes using the bootstrap script
2. Train and register a new model in the SageMaker Model Registry
3. Verify that the SageMaker pipeline is triggered automatically
4. Approve the manual approval step to complete the deployment

## Next Steps

- Consider adding additional validation steps before triggering the pipeline
- Implement notifications for pipeline failures
- Add metrics and monitoring for the model deployment process
