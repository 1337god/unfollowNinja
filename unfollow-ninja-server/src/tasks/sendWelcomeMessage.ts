import * as i18n from 'i18n';
import { Job } from 'kue';
import {Params, Twitter} from 'twit';
import { promisify } from 'util';
import {UserCategory} from '../dao/dao';
import logger from '../utils/logger';
import Task from './task';

i18n.configure({
    locales: ['en', 'fr'],
    directory: __dirname + '/../../locales',
});

export default class extends Task {
    public async run(job: Job) {
        const { username, userId } = job.data;
        const userDao = this.dao.getUserDao(userId);
        const dmTwit = await userDao.getDmTwit();
        i18n.setLocale(await userDao.getLang());

        const message = i18n.__('All set, welcome to @unfollowNinja {{emoji}}!\n' +
            'You will soon know all about your unfollowers here!', { emoji: '🙌' });

        await dmTwit.post('direct_messages/events/new', {
            event: {
                type: 'message_create',
                message_create: {target: {recipient_id: userId}, message_data: {text: message}},
            },
        } as Params)
            .catch((err) => this.manageTwitterErrors(err, username, userId));
    }

    private async manageTwitterErrors(err: any, username: string, userId: string): Promise<void> {

        if (!err.twitterReply) {
            throw err;
        }
        const twitterReply: Twitter.Errors = err.twitterReply;

        const userDao = this.dao.getUserDao(userId);

        for (const { code, message } of twitterReply.errors) {
            switch (code) {
                // app-related
                case 32:
                    throw new Error('Authentication problems.' +
                        'Please check that your consumer key & secret are correct.');
                case 416:
                    throw new Error('Oops, it looks like the application has been suspended :/...');
                // user-related
                case 89:
                    logger.warn('@%s revoked the token. removing them from the list...', username);
                    await userDao.setCategory(UserCategory.revoked);
                    break;
                case 326:
                case 64:
                    logger.warn('@%s is suspended. removing them from the list...', username);
                    await userDao.setCategory(UserCategory.suspended);
                    break;
                // twitter errors
                case 130: // over capacity
                case 131: // internal error`
                case 88: // rate limit
                    // retry in 15 minutes
                    await promisify((cb) =>
                        this.queue
                            .create('sendWelcomeMessage', {
                                title: `Resend welcome message to @${username} following an error ${code}`,
                                userId,
                                username,
                            })
                            .delay(15 * 60 * 1000)
                            .removeOnComplete(true)
                            .save(cb),
                    )();
                    break;
                default:
                    throw new Error(`An unexpected twitter error occured: ${code} ${message}`);
            }
        }
    }
}
