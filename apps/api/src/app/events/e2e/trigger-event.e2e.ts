import { expect } from 'chai';
import axios from 'axios';
import * as sinon from 'sinon';
import {
  LogRepository,
  MessageRepository,
  NotificationRepository,
  NotificationTemplateEntity,
  SubscriberEntity,
  SubscriberRepository,
  JobRepository,
  JobEntity,
  JobStatusEnum,
  IntegrationRepository,
  ExecutionDetailsRepository,
} from '@novu/dal';
import { UserSession, SubscribersService } from '@novu/testing';
import {
  ChannelTypeEnum,
  EmailBlockTypeEnum,
  StepTypeEnum,
  IEmailBlock,
  ISubscribersDefine,
  TemplateVariableTypeEnum,
  EmailProviderIdEnum,
  SmsProviderIdEnum,
  FilterPartTypeEnum,
  DigestUnitEnum,
  DelayTypeEnum,
  PreviousStepTypeEnum,
} from '@novu/shared';
import { RunJob, RunJobCommand } from '../usecases/run-job';
import { SendMessage } from '../usecases/send-message';
import { QueueNextJob } from '../usecases/queue-next-job';
import { StorageHelperService } from '../services/storage-helper-service/storage-helper.service';
import { EmailEventStatusEnum } from '@novu/stateless';
import { v4 as uuid } from 'uuid';

const axiosInstance = axios.create();

const eventTriggerPath = '/v1/events/trigger';

describe(`Trigger event - ${eventTriggerPath} (POST)`, function () {
  let session: UserSession;
  let template: NotificationTemplateEntity;
  let subscriber: SubscriberEntity;
  let subscriberService: SubscribersService;
  let runJob: RunJob;
  const notificationRepository = new NotificationRepository();
  const messageRepository = new MessageRepository();
  const subscriberRepository = new SubscriberRepository();
  const integrationRepository = new IntegrationRepository();
  const logRepository = new LogRepository();
  const jobRepository = new JobRepository();
  const executionDetailsRepository = new ExecutionDetailsRepository();

  beforeEach(async () => {
    session = new UserSession();
    await session.initialize();
    template = await session.createTemplate();
    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
    subscriber = await subscriberService.createSubscriber();
    runJob = new RunJob(
      jobRepository,
      session?.testServer?.getService(SendMessage),
      session?.testServer?.getService(QueueNextJob),
      session?.testServer?.getService(StorageHelperService)
    );
  });

  it('should trigger an event successfully', async function () {
    const response = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          firstName: 'Testing of User Name',
          urlVariable: '/test/url/path',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    const { data: body } = response;

    expect(body.data).to.be.ok;
    expect(body.data.status).to.equal('processed');
    expect(body.data.acknowledged).to.equal(true);
  });

  it('should create a subscriber based on event', async function () {
    const subscriberId = SubscriberRepository.createObjectId();
    const payload: ISubscribersDefine = {
      subscriberId,
      firstName: 'Test Name',
      lastName: 'Last of name',
      email: 'test@email.novu',
      locale: 'en',
    };
    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: {
          ...payload,
        },
        payload: {
          urlVar: '/test/url/path',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs();
    const createdSubscriber = await subscriberRepository.findBySubscriberId(session.environment._id, subscriberId);

    expect(createdSubscriber?.subscriberId).to.equal(subscriberId);
    expect(createdSubscriber?.firstName).to.equal(payload.firstName);
    expect(createdSubscriber?.lastName).to.equal(payload.lastName);
    expect(createdSubscriber?.email).to.equal(payload.email);
    expect(createdSubscriber?.locale).to.equal(payload.locale);
  });

  it('should override subscriber email based on event data', async function () {
    const subscriberId = SubscriberRepository.createObjectId();
    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: [
          { subscriberId: subscriber.subscriberId, email: 'gg@ff.com' },
          { subscriberId: subscriberId, email: 'gg@ff.com' },
        ],
        payload: {
          email: 'new-test-email@gmail.com',
          firstName: 'Testing of User Name',
          urlVar: '/test/url/path',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );
    await session.awaitRunningJobs();

    let jobs: JobEntity[] = await jobRepository.find({ _environmentId: session.environment._id });
    let statuses: JobStatusEnum[] = jobs.map((job) => job.status);

    expect(statuses.includes(JobStatusEnum.RUNNING)).true;
    expect(statuses.includes(JobStatusEnum.PENDING)).true;

    await session.awaitRunningJobs(template._id);

    jobs = await jobRepository.find({ _environmentId: session.environment._id, _templateId: template._id });
    statuses = jobs.map((job) => job.status).filter((value) => value !== JobStatusEnum.COMPLETED);

    expect(statuses.length).to.equal(0);

    const messages = await messageRepository.findBySubscriberChannel(
      session.environment._id,
      subscriber._id,
      ChannelTypeEnum.EMAIL
    );
    const createdSubscriber = await subscriberRepository.findBySubscriberId(session.environment._id, subscriberId);

    const messages2 = await messageRepository.findBySubscriberChannel(
      session.environment._id,
      createdSubscriber?._id as string,
      ChannelTypeEnum.EMAIL
    );

    expect(subscriber.email).to.not.equal('new-test-email@gmail.com');
    expect(messages[0].email).to.equal('new-test-email@gmail.com');
  });

  it('should generate message and notification based on event', async function () {
    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: {
          subscriberId: subscriber.subscriberId,
        },
        payload: {
          firstName: 'Testing of User Name',
          urlVar: '/test/url/path',
          attachments: [
            {
              name: 'text1.txt',
              file: 'hello world!',
            },
            {
              name: 'text2.txt',
              file: Buffer.from('hello world!', 'utf-8'),
            },
          ],
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const notifications = await notificationRepository.findBySubscriberId(session.environment._id, subscriber._id);

    expect(notifications.length).to.equal(1);

    const notification = notifications[0];

    expect(notification._organizationId).to.equal(session.organization._id);
    expect(notification._templateId).to.equal(template._id);

    const messages = await messageRepository.findBySubscriberChannel(
      session.environment._id,
      subscriber._id,
      ChannelTypeEnum.IN_APP
    );

    expect(messages.length).to.equal(1);
    const message = messages[0];

    expect(message.channel).to.equal(ChannelTypeEnum.IN_APP);
    expect(message.content as string).to.equal('Test content for <b>Testing of User Name</b>');
    expect(message.seen).to.equal(false);
    expect(message.cta.data.url).to.equal('/cypress/test-shell/example/test?test-param=true');
    expect(message.lastSeenDate).to.be.not.ok;
    expect(message.payload.firstName).to.equal('Testing of User Name');
    expect(message.payload.urlVar).to.equal('/test/url/path');
    expect(message.payload.attachments).to.be.not.ok;

    const emails = await messageRepository.findBySubscriberChannel(
      session.environment._id,
      subscriber._id,
      ChannelTypeEnum.EMAIL
    );

    expect(emails.length).to.equal(1);
    const email = emails[0];

    expect(email.channel).to.equal(ChannelTypeEnum.EMAIL);
  });

  it('should trigger SMS notification', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: [subscriber.subscriberId],
        payload: {
          customVar: 'Testing of User Name',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const message = await messageRepository._model.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
      channel: ChannelTypeEnum.SMS,
    });

    expect(message?.phone).to.equal(subscriber.phone);
  });

  it('should trigger SMS notification for all subscribers', async function () {
    const subscriberId = SubscriberRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Welcome to {{organizationName}}' as string,
        },
      ],
    });

    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: [{ subscriberId: subscriber.subscriberId }, { subscriberId: subscriberId, phone: '+972541111111' }],
        payload: {
          organizationName: 'Testing of Organization Name',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const message = await messageRepository._model.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
      channel: ChannelTypeEnum.SMS,
    });

    const createdSubscriber = await subscriberRepository.findBySubscriberId(session.environment._id, subscriberId);

    const message2 = await messageRepository._model.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: createdSubscriber?._id,
      channel: ChannelTypeEnum.SMS,
    });

    expect(message2?.phone).to.equal('+972541111111');
  });

  it('should trigger an sms error', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{firstName}}' as string,
        },
      ],
    });
    const { data: body } = await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          phone: '+972541111111',
          firstName: 'Testing of User Name',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const message = await messageRepository._model.findOne({
      _environmentId: session.environment._id,
      _templateId: template._id,
      _subscriberId: subscriber._id,
    });

    expect(message?.status).to.equal('error');
    expect(message?.errorText).to.contains('Currently 3rd-party packages test are not support on test env');
  });

  it('should trigger In-App notification with subscriber data', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.IN_APP;

    template = await createTemplate(session, channelType);

    await sendTrigger(session, template, newSubscriberIdInAppNotification);

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(message?.content).to.equal('Hello Smith, Welcome to Umbrella Corp');
  });

  it('should trigger SMS notification with subscriber data', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.SMS;

    template = await createTemplate(session, channelType);

    await sendTrigger(session, template, newSubscriberIdInAppNotification);

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(message?.content).to.equal('Hello Smith, Welcome to Umbrella Corp');
  });

  it('should trigger E-Mail notification with subscriber data', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.EMAIL;

    template = await createTemplate(session, channelType);

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{subscriber.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await sendTrigger(session, template, newSubscriberIdInAppNotification, {
      nested: {
        subject: 'a subject nested',
      },
    });

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    const block = message?.content[0] as IEmailBlock;

    expect(block.content).to.equal('Hello Smith, Welcome to Umbrella Corp');
    expect(message?.subject).to.equal('Test email a subject nested');
  });

  it('should not trigger notification with subscriber data if integration is inactive', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.SMS;

    const integration = await integrationRepository.findOne({
      _environmentId: session.environment._id,
      _organizationId: session.organization._id,
      providerId: SmsProviderIdEnum.Twilio,
    });

    await integrationRepository.update(
      { _environmentId: session.environment._id, _id: integration?._id },
      { active: false }
    );

    template = await createTemplate(session, channelType);

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test sms {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{subscriber.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await sendTrigger(session, template, newSubscriberIdInAppNotification, {
      nested: {
        subject: 'a subject nested',
      },
    });

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(message).to.be.null;
  });

  it('should use Novu integration for new orgs', async function () {
    process.env.NOVU_EMAIL_INTEGRATION_API_KEY = 'true';

    const existingIntegrations = await integrationRepository.find({
      _organizationId: session.organization._id,
      _environmentId: session.environment._id,
    });

    await integrationRepository.delete({
      _id: { $in: existingIntegrations.map((integration) => integration._id) },
      _organizationId: session.organization._id,
      _environmentId: session.environment._id,
    });

    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.EMAIL;

    template = await createTemplate(session, channelType);

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test sms {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{subscriber.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await sendTrigger(session, template, newSubscriberIdInAppNotification, {
      nested: {
        subject: 'a subject nested',
      },
    });

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(message?.providerId).to.equal(EmailProviderIdEnum.Novu);
  });

  it('should trigger message with active integration', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.EMAIL;

    template = await createTemplate(session, channelType);

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          content: [],
        },
      ],
    });

    await sendTrigger(session, template, newSubscriberIdInAppNotification, {
      nested: {
        subject: 'a subject nested',
      },
    });

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    let messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(messages.length).to.be.equal(1);
    expect(messages[0].providerId).to.be.equal(EmailProviderIdEnum.SendGrid);

    const payload = {
      providerId: 'mailgun',
      channel: 'email',
      credentials: { apiKey: '123', secretKey: 'abc' },
      active: true,
      check: false,
    };

    await session.testAgent.post('/v1/integrations').send(payload);

    await sendTrigger(session, template, newSubscriberIdInAppNotification, {
      nested: {
        subject: 'a subject nested',
      },
    });

    await session.awaitRunningJobs(template._id);

    messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    expect(messages.length).to.be.equal(2);
    expect(messages[1].providerId).to.be.equal(EmailProviderIdEnum.Mailgun);
  });

  it('should fail to trigger with missing variables', async function () {
    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          variables: [
            { name: 'myUser.lastName', required: true, type: TemplateVariableTypeEnum.STRING },
            { name: 'myUser.array', required: true, type: TemplateVariableTypeEnum.ARRAY },
            { name: 'myUser.bool', required: true, type: TemplateVariableTypeEnum.BOOLEAN },
          ],
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{myUser.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    let response = await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      })
      .expect(400);

    expect(JSON.stringify(response.body)).to.include(
      'payload is missing required key(s) and type(s): myUser.lastName (Value), myUser.array (Array), myUser.bool (Boolean)'
    );

    response = await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          myUser: {
            lastName: true,
            array: 'John Doe',
            bool: 0,
          },
        },
      })
      .expect(400);

    expect(JSON.stringify(response.body)).to.include(
      'payload is missing required key(s) and type(s): myUser.lastName (Value), myUser.array (Array), myUser.bool (Boolean)'
    );

    response = await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          myUser: {
            lastName: '',
            array: [],
            bool: true,
          },
        },
      })
      .expect(201);
  });

  it('should fill trigger payload with default variables', async function () {
    const newSubscriberIdInAppNotification = SubscriberRepository.createObjectId();
    const channelType = ChannelTypeEnum.EMAIL;

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          variables: [
            {
              name: 'myUser.lastName',
              required: false,
              type: TemplateVariableTypeEnum.STRING,
              defaultValue: 'John Doe',
            },
            {
              name: 'organizationName',
              required: false,
              type: TemplateVariableTypeEnum.STRING,
              defaultValue: 'Novu Corp',
            },
          ],
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{myUser.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: newSubscriberIdInAppNotification,
        payload: {
          organizationName: 'Umbrella Corp',
        },
      })
      .expect(201);

    await session.awaitRunningJobs(template._id);

    const createdSubscriber = await subscriberRepository.findBySubscriberId(
      session.environment._id,
      newSubscriberIdInAppNotification
    );

    const message = await messageRepository.findOne({
      _environmentId: session.environment._id,
      _subscriberId: createdSubscriber?._id,
      channel: channelType,
    });

    const block = message?.content[0] as IEmailBlock;

    expect(block.content).to.equal('Hello John Doe, Welcome to Umbrella Corp');
  });

  it('should throw an error when workflow identifier provided is not in the database', async () => {
    const response = await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: 'non-existent-template-identifier',
        to: subscriber.subscriberId,
        payload: {
          myUser: {
            lastName: 'Test',
          },
        },
      })
      .expect(422);

    const { body } = response;

    expect(body).to.eql({
      statusCode: 422,
      message: 'template_not_found',
      error: 'Unprocessable Entity',
    });
  });

  it('should handle empty workflow scenario', async function () {
    template = await session.createTemplate({
      steps: [],
    });

    const response = await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          myUser: {
            lastName: 'Test',
          },
        },
      })
      .expect(201);

    const { status, acknowledged } = response.body.data;
    expect(status).to.equal('no_workflow_steps_defined');
    expect(acknowledged).to.equal(true);
  });

  it('should trigger with given required variables', async function () {
    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email {{nested.subject}}',
          type: StepTypeEnum.EMAIL,
          variables: [{ name: 'myUser.lastName', required: true, type: TemplateVariableTypeEnum.STRING }],
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{myUser.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await session.testAgent
      .post(eventTriggerPath)
      .send({
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          myUser: {
            lastName: 'Test',
          },
        },
      })
      .expect(201);
  });

  it('should broadcast trigger to all subscribers', async () => {
    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
    await subscriberService.createSubscriber();
    await subscriberService.createSubscriber();

    const channelType = ChannelTypeEnum.EMAIL;

    template = await createTemplate(session, channelType);

    template = await session.createTemplate({
      steps: [
        {
          name: 'Message Name',
          subject: 'Test email subject',
          type: StepTypeEnum.EMAIL,
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'Hello {{subscriber.lastName}}, Welcome to {{organizationName}}' as string,
            },
          ],
        },
      ],
    });

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}/broadcast`,
      {
        name: template.triggers[0].identifier,
        payload: {
          organizationName: 'Umbrella Corp',
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );
    await session.awaitRunningJobs(template._id);
    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      channel: channelType,
    });

    expect(messages.length).to.equal(4);
    const isUnique = (value, index, self) => self.indexOf(value) === index;
    const subscriberIds = messages.map((message) => message._subscriberId).filter(isUnique);
    expect(subscriberIds.length).to.equal(4);
  });

  it('should not filter a message with correct payload', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Password reset',
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'This are the text contents of the template for {{firstName}}',
            },
            {
              type: EmailBlockTypeEnum.BUTTON,
              content: 'SIGN UP',
              url: 'https://url-of-app.com/{{urlVariable}}',
            },
          ],
          filters: [
            {
              isNegated: false,

              type: 'GROUP',

              value: 'AND',

              children: [
                {
                  field: 'run',
                  value: 'true',
                  operator: 'EQUAL',
                  on: FilterPartTypeEnum.PAYLOAD,
                },
              ],
            },
          ],
        },
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Password reset',
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'This are the text contents of the template for {{firstName}}',
            },
            {
              type: EmailBlockTypeEnum.BUTTON,
              content: 'SIGN UP',
              url: 'https://url-of-app.com/{{urlVariable}}',
            },
          ],
          filters: [
            {
              isNegated: false,

              type: 'GROUP',

              value: 'AND',

              children: [
                {
                  field: 'subscriberId',
                  value: subscriber.subscriberId,
                  operator: 'NOT_EQUAL',
                  on: FilterPartTypeEnum.SUBSCRIBER,
                },
              ],
            },
          ],
        },
      ],
    });

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {
          firstName: 'Testing of User Name',
          urlVariable: '/test/url/path',
          run: true,
        },
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(1);
  });

  it('should filter a message based on webhook filter', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Password reset',
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'This are the text contents of the template for {{firstName}}',
            },
            {
              type: EmailBlockTypeEnum.BUTTON,
              content: 'SIGN UP',
              url: 'https://url-of-app.com/{{urlVariable}}',
            },
          ],
          filters: [
            {
              isNegated: false,
              type: 'GROUP',
              value: 'AND',
              children: [
                {
                  field: 'isOnline',
                  value: 'true',
                  operator: 'EQUAL',
                  on: FilterPartTypeEnum.WEBHOOK,
                  webhookUrl: 'www.user.com/webhook',
                },
              ],
            },
          ],
        },
      ],
    });

    let axiosPostStub = sinon.stub(axios, 'post').resolves(
      Promise.resolve({
        data: { isOnline: true },
      })
    );

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    let messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(1);

    axiosPostStub.restore();
    axiosPostStub = sinon.stub(axios, 'post').resolves(
      Promise.resolve({
        data: { isOnline: false },
      })
    );

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(1);
    axiosPostStub.restore();
  });

  it('should throw exception on webhook filter - demo unavailable server', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Password reset',
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'This are the text contents of the template for {{firstName}}',
            },
            {
              type: EmailBlockTypeEnum.BUTTON,
              content: 'SIGN UP',
              url: 'https://url-of-app.com/{{urlVariable}}',
            },
          ],
          filters: [
            {
              isNegated: false,
              type: 'GROUP',
              value: 'AND',
              children: [
                {
                  field: 'isOnline',
                  value: 'true',
                  operator: 'EQUAL',
                  on: FilterPartTypeEnum.WEBHOOK,
                  webhookUrl: 'www.user.com/webhook',
                },
              ],
            },
          ],
        },
      ],
    });

    const axiosPostStub = sinon.stub(axios, 'post').throws(new Error('Users remote error'));

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    const messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(0);
    axiosPostStub.restore();
  });

  it('should backoff on exception while webhook filter (original request + 2 retries)', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Password reset',
          content: [
            {
              type: EmailBlockTypeEnum.TEXT,
              content: 'This are the text contents of the template for {{firstName}}',
            },
            {
              type: EmailBlockTypeEnum.BUTTON,
              content: 'SIGN UP',
              url: 'https://url-of-app.com/{{urlVariable}}',
            },
          ],
          filters: [
            {
              isNegated: false,
              type: 'GROUP',
              value: 'AND',
              children: [
                {
                  field: 'isOnline',
                  value: 'true',
                  operator: 'EQUAL',
                  on: FilterPartTypeEnum.WEBHOOK,
                  webhookUrl: 'www.user.com/webhook',
                },
              ],
            },
          ],
        },
      ],
    });

    let axiosPostStub = sinon.stub(axios, 'post');

    axiosPostStub
      .onCall(0)
      .throws(new Error('Users remote error'))
      .onCall(1)
      .resolves({
        data: { isOnline: true },
      });

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    let messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(1);

    axiosPostStub.restore();
    axiosPostStub = sinon
      .stub(axios, 'post')
      .onCall(0)
      .throws(new Error('Users remote error'))
      .onCall(1)
      .throws(new Error('Users remote error'))
      .onCall(2)
      .throws(new Error('Users remote error'))
      .resolves(
        Promise.resolve({
          data: { isOnline: true },
        })
      );

    await axiosInstance.post(
      `${session.serverUrl}${eventTriggerPath}`,
      {
        name: template.triggers[0].identifier,
        to: subscriber.subscriberId,
        payload: {},
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );

    await session.awaitRunningJobs(template._id);

    messages = await messageRepository.count({
      _environmentId: session.environment._id,
      _templateId: template._id,
    });

    expect(messages).to.equal(1);
    axiosPostStub.restore();
  });

  describe('seen/read filter', () => {
    it('should filter in app seen/read step', async function () {
      const firstStepUuid = uuid();
      template = await session.createTemplate({
        steps: [
          {
            type: StepTypeEnum.IN_APP,
            content: 'Not Delayed {{customVar}}' as string,
            uuid: firstStepUuid,
          },
          {
            type: StepTypeEnum.DELAY,
            content: '',
            metadata: {
              unit: DigestUnitEnum.MINUTES,
              amount: 5,
              type: DelayTypeEnum.REGULAR,
            },
          },
          {
            type: StepTypeEnum.IN_APP,
            content: 'Hello world {{customVar}}' as string,
            filters: [
              {
                isNegated: false,
                type: 'GROUP',
                value: 'AND',
                children: [
                  {
                    on: FilterPartTypeEnum.PREVIOUS_STEP,
                    stepType: PreviousStepTypeEnum.READ,
                    step: firstStepUuid,
                  },
                ],
              },
            ],
          },
        ],
      });

      await axiosInstance.post(
        `${session.serverUrl}${eventTriggerPath}`,
        {
          name: template.triggers[0].identifier,
          to: [subscriber.subscriberId],
          payload: {
            customVar: 'Testing of User Name',
          },
        },
        {
          headers: {
            authorization: `ApiKey ${session.apiKey}`,
          },
        }
      );

      await session.awaitRunningJobs(template?._id, true, 1);

      const delayedJob = await jobRepository.findOne({
        _environmentId: session.environment._id,
        _templateId: template._id,
        type: StepTypeEnum.DELAY,
      });

      if (!delayedJob) {
        throw new Error();
      }

      expect(delayedJob.status).to.equal(JobStatusEnum.DELAYED);

      const messages = await messageRepository.find({
        _environmentId: session.environment._id,
        _subscriberId: subscriber._id,
        channel: StepTypeEnum.IN_APP,
      });

      expect(messages.length).to.equal(1);

      await runJob.execute(
        RunJobCommand.create({
          jobId: delayedJob._id,
          environmentId: delayedJob._environmentId,
          organizationId: delayedJob._organizationId,
          userId: delayedJob._userId,
        })
      );
      await session.awaitRunningJobs(template?._id, true, 0);

      const messagesAfter = await messageRepository.find({
        _environmentId: session.environment._id,
        _subscriberId: subscriber._id,
        channel: StepTypeEnum.IN_APP,
      });

      expect(messagesAfter.length).to.equal(1);
    });

    it('should filter email seen/read step', async function () {
      const firstStepUuid = uuid();
      template = await session.createTemplate({
        steps: [
          {
            type: StepTypeEnum.EMAIL,
            name: 'Message Name',
            subject: 'Test email subject',
            content: [{ type: EmailBlockTypeEnum.TEXT, content: 'This is a sample text block' }],
            uuid: firstStepUuid,
          },
          {
            type: StepTypeEnum.DELAY,
            content: '',
            metadata: {
              unit: DigestUnitEnum.MINUTES,
              amount: 5,
              type: DelayTypeEnum.REGULAR,
            },
          },
          {
            type: StepTypeEnum.EMAIL,
            name: 'Message Name',
            subject: 'Test email subject',
            content: [{ type: EmailBlockTypeEnum.TEXT, content: 'This is a sample text block' }],
            filters: [
              {
                isNegated: false,
                type: 'GROUP',
                value: 'AND',
                children: [
                  {
                    on: FilterPartTypeEnum.PREVIOUS_STEP,
                    stepType: PreviousStepTypeEnum.READ,
                    step: firstStepUuid,
                  },
                ],
              },
            ],
          },
        ],
      });

      await axiosInstance.post(
        `${session.serverUrl}${eventTriggerPath}`,
        {
          name: template.triggers[0].identifier,
          to: [subscriber.subscriberId],
          payload: {
            customVar: 'Testing of User Name',
          },
        },
        {
          headers: {
            authorization: `ApiKey ${session.apiKey}`,
          },
        }
      );

      await session.awaitRunningJobs(template?._id, true, 1);

      const delayedJob = await jobRepository.findOne({
        _environmentId: session.environment._id,
        _templateId: template._id,
        type: StepTypeEnum.DELAY,
      });

      if (!delayedJob) {
        throw new Error();
      }

      expect(delayedJob.status).to.equal(JobStatusEnum.DELAYED);

      const messages = await messageRepository.find({
        _environmentId: session.environment._id,
        _subscriberId: subscriber._id,
        channel: StepTypeEnum.EMAIL,
      });

      expect(messages.length).to.equal(1);

      await executionDetailsRepository.create({
        _jobId: delayedJob._parentId,
        _messageId: messages[0]._id,
        _environmentId: session.environment._id,
        _organizationId: session.organization._id,
        webhookStatus: EmailEventStatusEnum.OPENED,
      });

      await runJob.execute(
        RunJobCommand.create({
          jobId: delayedJob._id,
          environmentId: delayedJob._environmentId,
          organizationId: delayedJob._organizationId,
          userId: delayedJob._userId,
        })
      );
      await session.awaitRunningJobs(template?._id, true, 0);

      const messagesAfter = await messageRepository.find({
        _environmentId: session.environment._id,
        _subscriberId: subscriber._id,
        channel: StepTypeEnum.EMAIL,
      });

      expect(messagesAfter.length).to.equal(1);
    });
  });
});

async function createTemplate(session, channelType) {
  return await session.createTemplate({
    steps: [
      {
        type: channelType,
        content: 'Hello {{subscriber.lastName}}, Welcome to {{organizationName}}' as string,
      },
    ],
  });
}

export async function sendTrigger(
  session,
  template,
  newSubscriberIdInAppNotification: string,
  payload: Record<string, unknown> = {}
) {
  await axiosInstance.post(
    `${session.serverUrl}${eventTriggerPath}`,
    {
      name: template.triggers[0].identifier,
      to: [{ subscriberId: newSubscriberIdInAppNotification, lastName: 'Smith', email: 'test@email.novu' }],
      payload: {
        organizationName: 'Umbrella Corp',
        ...payload,
      },
    },
    {
      headers: {
        authorization: `ApiKey ${session.apiKey}`,
      },
    }
  );
}
