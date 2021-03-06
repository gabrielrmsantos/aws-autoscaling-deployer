import AWS from "aws-sdk";
import chalk from "chalk";
import { Listr } from "listr2";
import { getCredential } from "./accountsAction.js";

const deployAction = async (asgName, options) => {
  const ctx = {
    arguments: {
      asgName,
      ...options
    }
  };

  const credential = getCredential(options.awsAccount);
  if(credential.error) {
    console.log(`${ chalk.redBright("[Error]") } Credential not found`);
    return true;
  }

  AWS.config.update({
    accessKeyId: credential.accessKey,
    secretAccessKey: credential.secretAccessKey,
    region: credential.region,
  });
  
  const autoScaling = new AWS.AutoScaling();
  const ec2 = new AWS.EC2();

  const tasks = new Listr(
    [
      {
        title: "Preparing instance for project update...",
        task: async (ctx, task) => task.newListr([
          {
            title: "selecting instance for update...",
            task: async (subCtx, task) => {
              const autoScalingGroupsDescription = await autoScaling.describeAutoScalingGroups({
                AutoScalingGroupNames: [ ctx.arguments.asgName ] 
              }).promise();

              if(autoScalingGroupsDescription.AutoScalingGroups.length < 1) {
                throw new Error("This auto scaling group doesn't exist");
              }

              const autoScalingGroup = autoScalingGroupsDescription.AutoScalingGroups[0];
              ctx.launchTemplateId = autoScalingGroup.LaunchTemplate.LaunchTemplateId;
              ctx.selectedInstanceId = autoScalingGroup.Instances.find((instance) => {
                return instance.HealthStatus === "Healthy" && instance.LifecycleState === "InService";
              }).InstanceId;

              const instancesDescription = await ec2.describeInstances({
                InstanceIds: [ ctx.selectedInstanceId ]
              }).promise();

              const instance = instancesDescription.Reservations[0].Instances[0];
              ctx.selectedInstancePublicIp = instance.PublicIpAddress;
              ctx.selectedInstancePrivateIp = instance.PrivateIpAddress;

              task.title = `selected instance ${ chalk.green(`[${ ctx.selectedInstanceId }]`) }`;
              
              return true;
            }
          }, {
            title: "detaching selected instance...",
            task: async (subCtx, task) => {              
              const response = await autoScaling.detachInstances({
                AutoScalingGroupName: ctx.arguments.asgName,
                InstanceIds: [ ctx.selectedInstanceId ],
                ShouldDecrementDesiredCapacity: false
              }).promise();

              return true;
            }
          }
        ])
      }, {
        title: "Updating detached instance...",
        task: async (ctx, task) => {
          // fazer a conexao ssh e dar os comandos para atualizar a maquina
          await sleep(3000);
          return true;
        }
      }, {
        title: "Creating ami and beginning instance refresh...",
        task: async (ctx, task) => task.newListr([
          {
            title: "creating image based on modified instance...",
            task: async (subCtx, task) => {
              const imageName = `${ ctx.arguments.asgName } v.${ new Date().getTime() }`;

              ctx.imageData = await ec2.createImage({
                Name: imageName,
                ImageIds: [ ctx.selectedInstanceId ]
              }).promise();

              await ec2.waitFor('imageAvailable', {ImageIds: [ctx.imageData.ImageId]}).promise();
            }
          }, {
            title: "creating new launch template version...",
            task: (subCtx, task) => {
               await ec2.createLaunchTemplateVersion({
                LaunchTemplateData: {
                 ImageId: ctx.imageData.ImageId
                }, 
                LaunchTemplateId: ctx.launchTemplateId , 
               }).promise();
            }
          }, {
            title: "killing detached instance...",
            task: (subCtx, task) => {
              await ec2.terminateInstance({
                InstanceIds: [ ctx.selectedInstanceId ]
              }).promise();
            }
          }, {
            title: "starting auto scaling instance refresh...",
            task: (subCtx, task) => {
              try{
                await autoScaling.startInstanceRefresh({
                  AutoScalingGroupName: ctx.arguments.asgName, 
                  DesiredConfiguration: {
                  LaunchTemplate: {
                    LaunchTemplateName: `${ ctx.arguments.asgName } v.${ new Date().getTime() }`, 
                    Version: "$Latest"
                  }
                  }, 
                  Preferences: {
                  InstanceWarmup: ctx.arguments.instanceWarmup, 
                  MinHealthyPercentage: ctx.arguments.healthyPercentage, 
                  SkipMatching: false
                  }
                }).promise();
              } catch(erro) {
                 await autoScaling.cancelInstanceRefresh({
                  AutoScalingGroupName: ctx.arguments.asgName
                 }).promise();
                 await autoScaling.startInstanceRefresh({
                  AutoScalingGroupName: ctx.arguments.asgName, 
                  DesiredConfiguration: {
                  LaunchTemplate: {
                    LaunchTemplateName: `${ ctx.arguments.asgName } v.${ new Date().getTime() }`, 
                    Version: "$Latest"
                  }
                  }, 
                  Preferences: {
                  InstanceWarmup: ctx.arguments.instanceWarmup, 
                  MinHealthyPercentage: ctx.arguments.healthyPercentage, 
                  SkipMatching: false
                  }
                }).promise();
              }
            }
          }
        ])
      }
    ], {
      concurrent: false,
      exitOnError: true,
      rendererOptions: {
        collapse: false
      },
      ctx
    }
  );

  try {
    await tasks.run();    
  } catch (e) {
    // ...
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default deployAction;