import { Readable } from 'stream';
import AxiosDigestAuth from '@koush/axios-digest-auth';
import { EventEmitter } from "stream";

function getChannel(channel: string) {
    return channel || '101';
}

export enum HikVisionCameraEvent {
    MotionDetected = "<eventType>VMD</eventType>",
    VideoLoss = "<eventType>videoloss</eventType>",
    // <eventType>linedetection</eventType>
    // <eventState>active</eventState>
    // <eventType>linedetection</eventType>
    // <eventState>inactive</eventState>
    LineDetection = "<eventType>linedetection</eventType>",
    // <eventType>fielddetection</eventType>
    // <eventState>active</eventState>
    // <eventType>fielddetection</eventType>
    // <eventState>inactive</eventState>
    FieldDetection = "<eventType>fielddetection</eventType>",
}


export interface HikVisionCameraStreamSetup {
    videoCodecType: string;
    audioCodecType: string;
}

export class HikVisionCameraAPI {
    digestAuth: AxiosDigestAuth;
    deviceModel : Promise<string>;
    listenerPromise : Promise<EventEmitter>;

    constructor(public ip: string, username: string, password: string, public console: Console) {
        this.digestAuth = new AxiosDigestAuth({
            username,
            password,
        });
    }

    async checkDeviceModel() : Promise<string> {
        if (!this.deviceModel) {
            this.deviceModel = new Promise(async (resolve, reject) => {
                try {
                    const response = await this.digestAuth.request({
                        method: "GET",
                        responseType: 'text',
                        url: `http://${this.ip}/ISAPI/System/deviceInfo`,
                    });
                    const deviceModel = response.data.match(/>(.*?)<\/model>/)?.[1];
                    resolve(deviceModel);    
                } catch (e) {
                    this.console.error('error checking NVR model', e);
                    resolve("unknown");
                }
            });
        }
        return await this.deviceModel;
    }

    async checkIsOldModel() : Promise<boolean> {
        // The old Hikvision DS-7608NI-E2 doesn't support channel capability checks, and the requests cause errors
        const model = await this.checkDeviceModel();
        return model.match(/DS-7608NI-E2/) != undefined;
    }

    async checkStreamSetup(channel: string): Promise<HikVisionCameraStreamSetup> {
        const isOld = await this.checkIsOldModel();
        if (isOld) {
            this.console.error('NVR is old version.  Defaulting camera capabilities to H.264/AAC');
            return {
                videoCodecType: "H.264",
                audioCodecType: "AAC",
            }
        }

        const response = await this.digestAuth.request({
            method: "GET",
            responseType: 'text',
            url: `http://${this.ip}/ISAPI/Streaming/channels/${getChannel(channel)}/capabilities`,
        });

        // this is bad:
        // <videoCodecType opt="H.264,H.265">H.265</videoCodecType>
        const vcodec = response.data.match(/>(.*?)<\/videoCodecType>/);
        const acodec = response.data.match(/>(.*?)<\/audioCompressionType>/);

        return {
            videoCodecType: vcodec?.[1],
            audioCodecType: acodec?.[1],
        }
    }

    async jpegSnapshot(channel: string): Promise<Buffer> {
        const url = `http://${this.ip}/ISAPI/Streaming/channels/${getChannel(channel)}/picture?snapShotImageType=JPEG`

        const response = await this.digestAuth.request({
            method: "GET",
            responseType: 'arraybuffer',
            url: url,
        });

        return Buffer.from(response.data);
    }

    async listenEvents() {
        // support multiple cameras listening to a single single stream 
        if (!this.listenerPromise) {
            this.listenerPromise = new Promise(async (resolve, reject) => {
                const url = `http://${this.ip}/ISAPI/Event/notification/alertStream`;
                this.console.log('listener url', url);

                const response = await this.digestAuth.request({
                    method: "GET",
                    url,
                    responseType: 'stream',
                });
                const stream = response.data as Readable;
        
                stream.on('data', (buffer: Buffer) => {
                    const data = buffer.toString();
                    // this.console.log(data);
                    for (const event of Object.values(HikVisionCameraEvent)) {
                        if (data.indexOf(event) !== -1) {
                            const cameraNumber = data.match(/<channelID>(.*?)</)?.[1] || data.match(/<dynChannelID>(.*?)</)?.[1];
                            stream.emit('event', event, cameraNumber);
                        }
                    }
                });
                resolve(stream);
            });
        }

        const eventSource = await this.listenerPromise;
        return eventSource;
    }
}
