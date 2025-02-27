import sdk, { ScryptedDeviceBase, DeviceProvider, Settings, Setting, ScryptedDeviceType, VideoCamera, MediaObject, MediaStreamOptions, ScryptedInterface, FFMpegInput, Camera, PictureOptions, SettingValue, DeviceCreator, DeviceCreatorSettings } from "@scrypted/sdk";
import { EventEmitter } from "stream";
import { recommendRebroadcast } from "./recommend";
import AxiosDigestAuth from '@koush/axios-digest-auth';
import https from 'https';
import { randomBytes } from "crypto";
import { CameraProviderBase, CameraBase, UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";

export { UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";

const { log, deviceManager, mediaManager } = sdk;

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

export class RtspCamera extends CameraBase<UrlMediaStreamOptions> {
    createRtspMediaStreamOptions(url: string, index: number) {
        return {
            id: `channel${index}`,
            name: `Stream ${index + 1}`,
            url,
            video: {
            },
            audio: this.isAudioDisabled() ? null : {},
        };
    }

    getRawVideoStreamOptions(): UrlMediaStreamOptions[] {
        let urls: string[] = [];
        try {
            urls = JSON.parse(this.storage.getItem('urls'));
        }
        catch (e) {
            const url = this.storage.getItem('url');
            if (url) {
                urls.push(url);
                this.storage.setItem('urls', JSON.stringify(urls));
                this.storage.removeItem('url');
            }
        }

        // filter out empty strings.
        const ret = urls.filter(url => !!url).map((url, index) => this.createRtspMediaStreamOptions(url, index));

        if (!ret.length)
            return;
        return ret;
    }

    async createVideoStream(vso: UrlMediaStreamOptions): Promise<MediaObject> {
        if (!vso)
            throw new Error('video streams not set up or no longer exists.');

        const url = new URL(vso.url);
        this.console.log('rtsp stream url', url.toString());
        const username = this.storage.getItem("username");
        const password = this.storage.getItem("password");
        if (username)
            url.username = username;
        if (password)
            url.password = password;

        const ret: FFMpegInput = {
            url: url.toString(),
            inputArguments: [
                "-rtsp_transport",
                "tcp",
                '-analyzeduration', '15000000',
                '-probesize', '10000000',
                "-reorder_queue_size",
                "1024",
                "-max_delay",
                "20000000",
                "-i",
                url.toString(),
            ],
            mediaStreamOptions: vso,
        };

        return mediaManager.createFFmpegMediaObject(ret);
    }

    // hide the description from CameraBase that indicates it is only used for snapshots
    getUsernameDescription(): string {
        return;
    }

    // hide the description from CameraBase that indicates it is only used for snapshots
    getPasswordDescription(): string {
        return;
    }

    async getRtspUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'urls',
                title: 'RTSP Stream URL',
                description: 'An RTSP Stream URL provided by the camera.',
                placeholder: 'rtsp://192.168.1.100[:554]/channel/101',
                value: this.getRawVideoStreamOptions()?.map(vso => vso.url),
                multiple: true,
            },
        ];
    }

    async getUrlSettings(): Promise<Setting[]> {
        return [
            ...await this.getSnapshotUrlSettings(),
            ...await this.getRtspUrlSettings(),
        ];
    }

    async putRtspUrls(urls: string[]) {
        this.storage.setItem('urls', JSON.stringify(urls.filter(url => !!url)));
    }

    async putSettingBase(key: string, value: SettingValue) {
        if (key === 'urls') {
            this.putRtspUrls(value as string[]);
        }
        else {
            super.putSettingBase(key, value);
        }
    }
}

export interface Destroyable {
    destroy(): void;
}

export abstract class RtspSmartCamera extends RtspCamera {
    lastListen = 0;
    listener: EventEmitter & Destroyable;

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);
        this.listenLoop();
    }

    resetSensors(): void {
        if (this.interfaces.includes(ScryptedInterface.MotionSensor))
            this.motionDetected = false;
        if (this.interfaces.includes(ScryptedInterface.AudioSensor))
            this.audioDetected = false;
        if (this.interfaces.includes(ScryptedInterface.IntrusionSensor))
            this.intrusionDetected = false;
        if (this.interfaces.includes(ScryptedInterface.BinarySensor))
            this.binaryState = false;
    }

    listenLoop() {
        this.resetSensors();
        this.lastListen = Date.now();
        this.listener = this.listenEvents();
        this.listener.on('error', e => {
            this.console.error('listen loop error, restarting in 10 seconds', e);
            const listenDuration = Date.now() - this.lastListen;
            const listenNext = listenDuration > 10000 ? 0 : 10000;
            setTimeout(() => this.listenLoop(), listenNext);
        });
    }

    async putSetting(key: string, value: SettingValue) {
        this.putSettingBase(key, value);
        this.listener.emit('error', new Error("new settings"));
    }

    async takePictureThrottled(option?: PictureOptions) {
        if (this.showSnapshotUrlOverride() && this.getSnapshotUrl()) {
            return super.takePictureThrottled(option);
        }

        return this.takeSmartCameraPicture(option);;
    }

    abstract takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject>;

    async getSnapshotUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'snapshotUrl',
                title: 'Snapshot URL Override',
                placeholder: 'http://192.168.1.100[:80]/snapshot.jpg',
                value: this.storage.getItem('snapshotUrl'),
                description: 'Override the snapshot URL that will returns the current JPEG image.'
            },
        ];
    }

    async getRtspUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'urls',
                title: 'RTSP Stream URL Override',
                description: 'Override the RTSP Stream URL provided by the camera.',
                placeholder: 'rtsp://192.168.1.100[:554]/channel/101',
                value: this.getRawVideoStreamOptions()?.map(vso => vso.url),
                multiple: true,
            },
        ];
    }

    async getUrlSettings() {
        const ret: Setting[] = [
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.1.100',
                value: this.storage.getItem('ip'),
            },
            ...this.getHttpPortOverrideSettings(),
            ...this.getRtspPortOverrideSettings(),
        ];

        if (this.showRtspUrlOverride()) {
            const legacyOverride = this.storage.getItem('rtspUrlOverride')
            if (legacyOverride) {
                await this.putRtspUrls([legacyOverride]);
                this.storage.removeItem('rtspUrlOverride');
            }

            ret.push(
                ... await this.getRtspUrlSettings(),
            );
        }

        if (this.showSnapshotUrlOverride()) {
            ret.push(
                ... await this.getSnapshotUrlSettings(),
            );
        }

        return ret;
    }

    getHttpPortOverrideSettings() {
        if (!this.showHttpPortOverride()) {
            return [];
        }
        return [
            {
                key: 'httpPort',
                title: 'HTTP Port Override',
                placeholder: '80',
                value: this.storage.getItem('httpPort'),
            }
        ];
    }

    showHttpPortOverride() {
        return true;
    }

    getRtspPortOverrideSettings() {
        if (!this.showRtspPortOverride()) {
            return [];
        }
        return [
            {
                key: 'rtspPort',
                title: 'RTSP Port Override',
                placeholder: '554',
                value: this.storage.getItem('rtspPort'),
            },
        ];
    }

    showRtspPortOverride() {
        return true;
    }

    showRtspUrlOverride() {
        return true;
    }

    showSnapshotUrlOverride() {
        return true;
    }

    getHttpAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('httpPort') || 80}`;
    }

    setHttpPortOverride(port: string) {
        this.storage.setItem('httpPort', port);
    }

    getRtspUrlOverride(options?: MediaStreamOptions) {
        if (!this.showRtspUrlOverride())
            return;
        return this.storage.getItem('rtspUrlOverride');
    }

    abstract getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]>;
    abstract listenEvents(): EventEmitter & Destroyable;

    getIPAddress() {
        return this.storage.getItem('ip');
    }

    setIPAddress(ip: string) {
        return this.storage.setItem('ip', ip);
    }

    getRtspAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('rtspPort') || 554}`;
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (this.showRtspUrlOverride()) {
            const vso = await super.getVideoStreamOptions();
            if (vso)
                return vso;
        }

        const vsos = await this.getConstructedVideoStreamOptions();
        return this.getDefaultOrderedVideoStreamOptions(vsos);
    }
}

export class RtspProvider extends CameraProviderBase<UrlMediaStreamOptions> {
    createCamera(nativeId: string): RtspCamera {
        return new RtspCamera(nativeId, this);
    }
}
