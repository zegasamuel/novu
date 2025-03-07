import { Injectable } from '@nestjs/common';
import {
  MessageTemplateRepository,
  NotificationTemplateEntity,
  SubscriberPreferenceRepository,
  SubscriberRepository,
  SubscriberEntity,
} from '@novu/dal';
import { ChannelTypeEnum } from '@novu/stateless';
import { IPreferenceChannels } from '@novu/shared';
import {
  IGetSubscriberPreferenceTemplateResponse,
  ISubscriberPreferenceResponse,
} from '../get-subscriber-preference/get-subscriber-preference.usecase';
import { GetSubscriberTemplatePreferenceCommand } from './get-subscriber-template-preference.command';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { CachedEntity } from '../../../shared/interceptors/cached-entity.interceptor';
import { buildSubscriberKey } from '../../../shared/services/cache/key-builders/entities';

@Injectable()
export class GetSubscriberTemplatePreference {
  constructor(
    private subscriberPreferenceRepository: SubscriberPreferenceRepository,
    private messageTemplateRepository: MessageTemplateRepository,
    private subscriberRepository: SubscriberRepository
  ) {}

  async execute(command: GetSubscriberTemplatePreferenceCommand): Promise<ISubscriberPreferenceResponse> {
    const activeChannels = await this.queryActiveChannels(command);
    const subscriber =
      command.subscriber ??
      (await this.subscriberRepository.findBySubscriberId(command.environmentId, command.subscriberId));
    if (!subscriber) {
      throw new ApiException(`Subscriber ${command.subscriberId} not found`);
    }

    const subscriberPreference = await this.subscriberPreferenceRepository.findOne({
      _environmentId: command.environmentId,
      _subscriberId: subscriber._id,
      _templateId: command.template._id,
    });

    const responseTemplate = mapResponseTemplate(command.template);
    const subscriberPreferenceEnabled = subscriberPreference?.enabled ?? true;

    if (subscriberPreferenceIsWhole(subscriberPreference?.channels, activeChannels)) {
      return getResponse(responseTemplate, subscriberPreferenceEnabled, subscriberPreference?.channels, activeChannels);
    }

    const templatePreference = command.template.preferenceSettings;

    if (templatePreference) {
      if (!subscriberPreference?.channels) {
        return getResponse(responseTemplate, subscriberPreferenceEnabled, templatePreference, activeChannels);
      }

      const mergedPreference = Object.assign({}, templatePreference, subscriberPreference.channels);

      return getResponse(responseTemplate, subscriberPreferenceEnabled, mergedPreference, activeChannels);
    }

    return getNoSettingFallback(responseTemplate, activeChannels);
  }

  private async queryActiveChannels(command: GetSubscriberTemplatePreferenceCommand): Promise<ChannelTypeEnum[]> {
    const messageIds = command.template.steps.filter((step) => step.active === true).map((step) => step._templateId);

    const messageTemplates = await this.messageTemplateRepository.find({
      _environmentId: command.environmentId,
      _id: {
        $in: messageIds,
      },
    });

    return [
      ...new Set(messageTemplates.map((messageTemplate) => messageTemplate.type) as unknown as ChannelTypeEnum[]),
    ];
  }

  @CachedEntity({
    builder: (command: { subscriberId: string; _environmentId: string }) =>
      buildSubscriberKey({
        _environmentId: command._environmentId,
        subscriberId: command.subscriberId,
      }),
  })
  private async fetchSubscriber({
    subscriberId,
    _environmentId,
  }: {
    subscriberId: string;
    _environmentId: string;
  }): Promise<SubscriberEntity | null> {
    return await this.subscriberRepository.findBySubscriberId(_environmentId, subscriberId);
  }
}

function filterActiveChannels(
  activeChannels: ChannelTypeEnum[],
  preference?: IPreferenceChannels
): IPreferenceChannels {
  const filteredChannels = Object.assign({}, preference);
  for (const key in preference) {
    if (!activeChannels.some((channel) => channel === key)) {
      delete filteredChannels[key];
    }
  }

  return filteredChannels;
}

function getNoSettingFallback(
  template: IGetSubscriberPreferenceTemplateResponse,
  activeChannels: ChannelTypeEnum[]
): ISubscriberPreferenceResponse {
  return getResponse(
    template,
    true,
    {
      email: true,
      sms: true,
      in_app: true,
      chat: true,
      push: true,
    },
    activeChannels
  );
}

function mapResponseTemplate(template: NotificationTemplateEntity): IGetSubscriberPreferenceTemplateResponse {
  return {
    _id: template._id,
    name: template.name,
    critical: template.critical != null ? template.critical : true,
  };
}

function subscriberPreferenceIsWhole(
  preference?: IPreferenceChannels | null,
  activeChannels?: ChannelTypeEnum[] | null
): boolean {
  if (!preference || !activeChannels) return false;

  return Object.keys(preference).length === activeChannels.length;
}

function getResponse(
  responseTemplate: IGetSubscriberPreferenceTemplateResponse,
  subscriberPreferenceEnabled: boolean,
  subscriberPreferenceChannels: IPreferenceChannels | undefined,
  activeChannels: ChannelTypeEnum[]
): ISubscriberPreferenceResponse {
  return {
    template: responseTemplate,
    preference: {
      enabled: subscriberPreferenceEnabled,
      channels: filterActiveChannels(activeChannels, subscriberPreferenceChannels),
    },
  };
}
