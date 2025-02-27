import path from 'path';
import process from 'process';
import http from 'http';
import https from 'https';
import express from 'express';
import bodyParser from 'body-parser';
import net from 'net';
import { startPluginRemote } from './plugin/plugin-host';
import { ScryptedRuntime } from './runtime';
import level from './level';
import { Plugin, ScryptedUser, Settings } from './db-types';
import { SCRYPTED_DEBUG_PORT, SCRYPTED_INSECURE_PORT, SCRYPTED_SECURE_PORT } from './server-settings';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import qs from 'query-string';
import { RPCResultError } from './rpc';
import fs from 'fs';
import mkdirp from 'mkdirp';
import { install as installSourceMapSupport } from 'source-map-support';
import httpAuth from 'http-auth';
import semver from 'semver';
import { Info } from './services/info';
import { getAddresses } from './addresses';
import { sleep } from './sleep';
import { createSelfSignedCertificate, CURRENT_SELF_SIGNED_CERTIFICATE_VERSION } from './cert';
import { PluginError } from './plugin/plugin-error';
import { getScryptedVolume } from './plugin/plugin-volume';

if (!semver.gte(process.version, '16.0.0')) {
    throw new Error('"node" version out of date. Please update node to v16 or higher.')
}

process.on('unhandledRejection', error => {
    if (error?.constructor !== RPCResultError && error?.constructor !== PluginError) {
        throw error;
    }
    console.warn('unhandled rejection of RPC Result', error);
});

function listenServerPort(env: string, port: number, server: any) {
    server.listen(port,);
    server.on('error', (e: Error) => {
        console.error(`Failed to listen on port ${port}. It may be in use.`);
        console.error(`Use the environment variable ${env} to change the port.`);
        throw e;
    })
}

if (process.argv[2] === 'child') {
    startPluginRemote();
}
else {
    installSourceMapSupport({
        environment: 'node',
    });

    let workerInspectPort: number = undefined;

    async function doconnect(): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const target = net.connect(workerInspectPort);
            target.once('error', reject)
            target.once('connect', () => resolve(target))
        })
    }

    const debugServer = net.createServer(async (socket) => {
        if (!workerInspectPort) {
            socket.destroy();
            return;
        }

        for (let i = 0; i < 10; i++) {
            try {
                const target = await doconnect();
                socket.pipe(target).pipe(socket);
                const destroy = () => {
                    socket.destroy();
                    target.destroy();
                }
                socket.on('error', destroy);
                target.on('error', destroy);
                socket.on('close', destroy);
                target.on('close', destroy);
                return;
            }
            catch (e) {
                await sleep(500);
            }
        }
        console.warn('debugger connect timed out');
        socket.destroy();
    })
    listenServerPort('SCRYPTED_DEBUG_PORT', SCRYPTED_DEBUG_PORT, debugServer);

    const app = express();

    // parse application/x-www-form-urlencoded
    app.use(bodyParser.urlencoded({ extended: false }) as any)

    // parse application/json
    app.use(bodyParser.json())

    // parse some custom thing into a Buffer
    app.use(bodyParser.raw({ type: 'application/zip', limit: 100000000 }) as any)

    async function start() {
        const volumeDir = getScryptedVolume();
        mkdirp.sync(volumeDir);
        const dbPath = path.join(volumeDir, 'scrypted.db');
        const oldDbPath = path.join(process.cwd(), 'scrypted.db');
        if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
            mkdirp.sync(volumeDir);
            fs.renameSync(oldDbPath, dbPath);
        }
        const db = level(dbPath);
        await db.open();

        if (process.env.SCRYPTED_RESET_ALL_USERS === 'true') {
            await db.removeAll(ScryptedUser);
        }

        let certSetting = await db.tryGet(Settings, 'certificate') as Settings;

        if (certSetting?.value?.version !== CURRENT_SELF_SIGNED_CERTIFICATE_VERSION) {
            const cert = createSelfSignedCertificate();

            certSetting = new Settings();
            certSetting._id = 'certificate';
            certSetting.value = cert;
            certSetting = await db.upsert(certSetting);
        }


        const basicAuth = httpAuth.basic({
            realm: 'Scrypted',
        }, async (username, password, callback) => {
            const user = await db.tryGet(ScryptedUser, username);
            if (!user) {
                callback(false);
                return;
            }

            const salted = user.salt + password;
            const hash = crypto.createHash('sha256');
            hash.update(salted);
            const sha = hash.digest().toString('hex');

            callback(sha === user.passwordHash || password === user.token);
        });

        const keys = certSetting.value;

        const httpsServerOptions = process.env.SCRYPTED_HTTPS_OPTIONS_FILE
            ? JSON.parse(fs.readFileSync(process.env.SCRYPTED_HTTPS_OPTIONS_FILE).toString())
            : {};

        const mergedHttpsServerOptions = Object.assign({
            key: keys.serviceKey,
            cert: keys.certificate
        }, httpsServerOptions);
        const secure = https.createServer(mergedHttpsServerOptions, app);
        listenServerPort('SCRYPTED_SECURE_PORT', SCRYPTED_SECURE_PORT, secure);
        const insecure = http.createServer(app);
        listenServerPort('SCRYPTED_INSECURE_PORT', SCRYPTED_INSECURE_PORT, insecure);

        // legacy secure port 9443 is now in use by portainer.
        let shownLegacyPortAlert = false
        const legacySecure = https.createServer(mergedHttpsServerOptions, (req, res) => {
            if (!shownLegacyPortAlert) {
                const core = scrypted.findPluginDevice('@scrypted/core');
                if (core) {
                    const logger = scrypted.getDeviceLogger(core);
                    shownLegacyPortAlert = true;
                    const host = (req.headers.host || 'localhost').split(':')[0];
                    const newUrl = `https://${host}:${SCRYPTED_SECURE_PORT}`;
                    logger.log('a', `Due to a port conflict with Portainer, the default Scrypted URL has changed to ${newUrl}`);
                }
            }
            app(req, res);
        });
        legacySecure.listen(9443);
        legacySecure.on('error', () => {
            // can ignore.
        });

        // use a hash of the private key as the cookie secret.
        app.use(cookieParser(crypto.createHash('sha256').update(certSetting.value.serviceKey).digest().toString('hex')));

        app.all('*', async (req, res, next) => {
            // this is a trap for all auth.
            // only basic auth will fail with 401. it is up to the endpoints to manage
            // lack of login from cookie auth.

            const { login_user_token } = req.signedCookies;
            if (login_user_token) {
                const userTokenParts = login_user_token.split('#');
                const username = userTokenParts[0];
                const timestamp = parseInt(userTokenParts[1]);
                if (timestamp + 86400000 < Date.now()) {
                    console.warn('login expired');
                    return next();
                }

                const user = await db.tryGet(ScryptedUser, username);
                if (!user) {
                    console.warn('login not found');
                    return next();
                }

                res.locals.username = username;
            }
            next();
        });

        // allow basic auth to deploy plugins
        app.all('/web/component/*', (req, res, next) => {
            if (req.protocol === 'https' && req.headers.authorization && req.headers.authorization.toLowerCase()?.indexOf('basic') !== -1) {
                const basicChecker = basicAuth.check((req) => {
                    res.locals.username = req.user;
                    next();
                });

                // this automatically handles unauthorized.
                basicChecker(req, res);
                return;
            }
            next();
        })

        // verify all plugin related requests have some sort of auth
        app.all('/web/component/*', (req, res, next) => {
            if (!res.locals.username) {
                res.status(401);
                res.send('Not Authorized');
                return;
            }
            next();
        });

        console.log('#######################################################');
        console.log(`Scrypted Server (Local)   : https://localhost:${SCRYPTED_SECURE_PORT}/`);
        for (const address of getAddresses()) {
            console.log(`Scrypted Server (Remote)  : https://${address}:${SCRYPTED_SECURE_PORT}/`);
        }
        console.log(`Version:       : ${await new Info().getVersion()}`);
        console.log('#######################################################');
        console.log('Chrome Users: You may need to type "thisisunsafe" into')
        console.log('              the window to bypass the warning. There')
        console.log('              may be no button to continue, type the')
        console.log('              letters "thisisunsafe" and it will proceed.')
        console.log('#######################################################');
        console.log('Scrypted insecure http service port:', SCRYPTED_INSECURE_PORT);
        console.log('Ports can be changed with environment variables.')
        console.log('https: $SCRYPTED_SECURE_PORT')
        console.log('http : $SCRYPTED_INSECURE_PORT')
        console.log('Certificate can be modified via tls.createSecureContext options in')
        console.log('JSON file located at SCRYPTED_HTTPS_OPTIONS_FILE environment variable:');
        console.log('export SCRYPTED_HTTPS_OPTIONS_FILE=/path/to/options.json');
        console.log('https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions')
        console.log('#######################################################');
        const scrypted = new ScryptedRuntime(db, insecure, secure, app);
        await scrypted.start();

        app.get(['/web/component/script/npm/:pkg', '/web/component/script/npm/@:owner/:pkg'], async (req, res) => {
            const { owner, pkg } = req.params;
            let endpoint = pkg;
            if (owner)
                endpoint = `@${owner}/${endpoint}`;
            try {
                const response = await axios(`https://registry.npmjs.org/${endpoint}`);
                res.send(response.data);
            }
            catch (e) {
                res.status(500);
                res.end();
            }
        });

        app.post(['/web/component/script/install/:pkg', '/web/component/script/install/@:owner/:pkg', '/web/component/script/install/@:owner/:pkg/:tag'], async (req, res) => {
            const { owner, pkg, tag } = req.params;
            let endpoint = pkg;
            if (owner)
                endpoint = `@${owner}/${endpoint}`;
            try {
                const plugin = await scrypted.installNpm(endpoint, tag);
                res.send({
                    id: scrypted.findPluginDevice(plugin.pluginId)._id,
                });
            }
            catch (e) {
                res.status(500);
                res.end();
            }
        });

        app.get('/web/component/script/search', async (req, res) => {
            try {
                const query = qs.stringify({
                    text: req.query.text,
                })
                const response = await axios(`https://registry.npmjs.org/-/v1/search?${query}`);
                res.send(response.data);
            }
            catch (e) {
                res.status(500);
                res.end();
            }
        });

        app.post('/web/component/script/setup', async (req, res) => {
            const npmPackage = req.query.npmPackage as string;
            const plugin = await db.tryGet(Plugin, npmPackage) || new Plugin();

            plugin._id = npmPackage;
            plugin.packageJson = req.body;

            await db.upsert(plugin);

            res.send('ok');
        });

        app.post('/web/component/script/deploy', async (req, res) => {
            const npmPackage = req.query.npmPackage as string;
            const plugin = await db.tryGet(Plugin, npmPackage);

            if (!plugin) {
                res.status(500);
                res.send(`npm package ${npmPackage} not found`);
                return;
            }

            plugin.zip = req.body.toString('base64');
            await db.upsert(plugin);

            const noRebind = req.query['no-rebind'] !== undefined;
            if (!noRebind)
                await scrypted.installPlugin(plugin);

            res.send('ok');
        });

        app.post('/web/component/script/debug', async (req, res) => {
            const npmPackage = req.query.npmPackage as string;
            const plugin = await db.tryGet(Plugin, npmPackage);

            if (!plugin) {
                res.status(500);
                res.send(`npm package ${npmPackage} not found`);
                return;
            }

            const waitDebug = new Promise<void>((resolve, reject) => {
                setTimeout(() => reject(new Error('timed out waiting for debug session')), 30000);
                debugServer.on('connection', resolve);
            });

            workerInspectPort = Math.round(Math.random() * 10000) + 30000;
            try {
                await scrypted.installPlugin(plugin, {
                    waitDebug,
                    inspectPort: workerInspectPort,
                });
            }
            catch (e) {
                res.status(500);
                res.send(e.toString());
                return
            }

            res.send({
                workerInspectPort,
            });
        });

        app.get('/logout', (req, res) => {
            res.clearCookie('login_user_token');
            res.send({});
        });

        app.post('/login', async (req, res) => {
            const hasLogin = await db.getCount(ScryptedUser) > 0;

            const { username, password, change_password } = req.body;
            const timestamp = Date.now();
            const maxAge = 86400000;

            if (hasLogin) {

                const user = await db.tryGet(ScryptedUser, username);
                if (!user) {
                    res.send({
                        error: 'User does not exist.',
                        hasLogin,
                    })
                    return;
                }

                const salted = user.salt + password;
                const hash = crypto.createHash('sha256');
                hash.update(salted);
                const sha = hash.digest().toString('hex');
                if (user.passwordHash !== sha) {
                    res.send({
                        error: 'Incorrect password.',
                        hasLogin,
                    })
                    return;
                }

                const login_user_token = `${username}#${timestamp}`;
                res.cookie('login_user_token', login_user_token, {
                    maxAge,
                    secure: true,
                    signed: true,
                    httpOnly: true,
                });

                if (change_password) {
                    user.salt = crypto.randomBytes(64).toString('base64');
                    user.passwordHash = crypto.createHash('sha256').update(user.salt + change_password).digest().toString('hex');
                    user.passwordDate = timestamp;
                    await db.upsert(user);
                }

                res.send({
                    username,
                    expiration: maxAge,
                });

                return;
            }

            const user = new ScryptedUser();
            user._id = username;
            user.salt = crypto.randomBytes(64).toString('base64');
            user.passwordHash = crypto.createHash('sha256').update(user.salt + password).digest().toString('hex');
            user.passwordDate = timestamp;
            await db.upsert(user);

            const login_user_token = `${username}#${timestamp}`
            res.cookie('login_user_token', login_user_token, {
                maxAge,
                secure: true,
                signed: true,
                httpOnly: true,
            });

            res.send({
                username,
                expiration: maxAge,
            });
        });

        app.get('/login', async (req, res) => {
            if (req.protocol === 'https' && req.headers.authorization) {
                const username = await new Promise(resolve => {
                    const basicChecker = basicAuth.check((req) => {
                        resolve(req.user);
                    });

                    // this automatically handles unauthorized.
                    basicChecker(req, res);
                });

                const user = await db.tryGet(ScryptedUser, username);
                if (!user.token) {
                    user.token = crypto.randomBytes(16).toString('hex');
                    await db.upsert(user);
                }
                res.send({
                    username,
                    token: user.token,
                });
                return;
            }

            const hasLogin = await db.getCount(ScryptedUser) > 0;
            const { login_user_token } = req.signedCookies;
            if (!login_user_token) {
                res.send({
                    error: 'Not logged in.',
                    hasLogin,
                })
                return;
            }

            const userTokenParts = login_user_token.split('#');
            const username = userTokenParts[0];
            const timestamp = parseInt(userTokenParts[1]);
            if (timestamp + 86400000 < Date.now()) {
                res.send({
                    error: 'Login expired.',
                    hasLogin,
                })
                return;
            }

            const user = await db.tryGet(ScryptedUser, username);
            if (!user) {
                res.send({
                    error: 'User not found.',
                    hasLogin,
                })
                return;
            }

            if (timestamp < user.passwordDate) {
                res.send({
                    error: 'Login invalid. Password has changed.',
                    hasLogin,
                })
                return;
            }

            res.send({
                expiration: 86400000 - (Date.now() - timestamp),
                username,
            })
        });

        app.get('/', (_req, res) => res.redirect('/endpoint/@scrypted/core/public/'));
    }

    module.exports = start();
}
