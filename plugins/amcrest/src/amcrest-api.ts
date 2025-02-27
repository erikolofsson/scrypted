import AxiosDigestAuth from '@koush/axios-digest-auth';
import { Readable } from 'stream';
import https from 'https';

export enum AmcrestEvent {
    MotionStart = "Code=VideoMotion;action=Start",
    MotionStop = "Code=VideoMotion;action=Stop",
    AudioStart = "Code=AudioMutation;action=Start",
    AudioStop = "Code=AudioMutation;action=Stop",
    TalkInvite = "Code=_DoTalkAction_;action=Invite",
    TalkHangup = "Code=_DoTalkAction_;action=Hangup",
    TalkPulse = "Code=_DoTalkAction_;action=Pulse",
    AlarmIPCStart = "Code=AlarmIPC;action=Start",
    AlarmIPCStop = "Code=AlarmIPC;action=Stop",
    PhoneCallDetectStart = "Code=PhoneCallDetect;action=Start",
    PhoneCallDetectStop = "Code=PhoneCallDetect;action=Stop",
}

export const amcrestHttpsAgent = new https.Agent({
    rejectUnauthorized: false
});

export class AmcrestCameraClient {
    digestAuth: AxiosDigestAuth;

    constructor(public ip: string, username: string, password: string, public console?: Console) {
        this.digestAuth = new AxiosDigestAuth({
            username,
            password,
        });
    }

    async jpegSnapshot(): Promise<Buffer> {

        const response = await this.digestAuth.request({
            httpsAgent: amcrestHttpsAgent,
            method: "GET",
            responseType: 'arraybuffer',
            url: `http://${this.ip}/cgi-bin/snapshot.cgi`,
        });

        return Buffer.from(response.data);
    }

    async listenEvents() {
        const url = `http://${this.ip}/cgi-bin/eventManager.cgi?action=attach&codes=[All]`;
        console.log('preparing event listener', url);

        const response = await this.digestAuth.request({
            httpsAgent: amcrestHttpsAgent,
            method: "GET",
            responseType: 'stream',
            url,
        });
        const stream = response.data as Readable;

        stream.on('data', (buffer: Buffer) => {
            const data = buffer.toString();
            const parts = data.split(';');
            let index: string;
            try {
                for (const part of parts) {
                    if (part.startsWith('index')) {
                        index = part.split('=')[1]?.trim();
                    }
                }
            }
            catch (e) {
                this.console.error('error parsing index', data);
            }
            // this.console?.log('event', data);
            for (const event of Object.values(AmcrestEvent)) {
                if (data.indexOf(event) !== -1) {
                    stream.emit('event', event, index);
                }
            }
        });

        return stream;
    }
}
