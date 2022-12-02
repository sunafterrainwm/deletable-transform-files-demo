import crypto = require( 'node:crypto' );
import fs = require( 'node:fs' );
import path = require( 'node:path' );
import stream = require( 'node:stream' );
import util = require( 'node:util' );

import dotenv = require( 'dotenv' );
import express = require( 'express' );
import { Context, Markup, NarrowedContext, Telegraf } from 'telegraf';
import { stream as fetchStream } from 'undici';

import * as TT from 'typegram';

import * as logger from './logger.mjs';

dotenv.config();

const app = express();

process.on( 'unhandledRejection', function ( _reason, promise ) {
	promise.catch( function ( e ) {
		logger.main.error( 'Unhandled Rejection:', e );
	} );
} );

process.on( 'uncaughtException', function ( err ) {
	logger.main.error( 'Uncaught exception:', err );
} );

process.on( 'rejectionHandled', function () {
	// 忽略
} );

process.on( 'warning', ( warning ) => {
	logger.main.warn( warning );
} );

function getEnv( name: string ): string;
function getEnv( name: string, nullOk: true ): string | null;
function getEnv( name: string, nullOk = false ): string | null {
	const find = process.env[ name ];
	if ( find ) {
		return find;
	}
	if ( nullOk ) {
		return null;
	}
	logger.main.error( 'process.env[ ' + JSON.stringify( name ) + ' ] not found.' );
	process.exit( 1 );
}
const bot = new Telegraf( getEnv( 'BOT_TOKEN' ) );
const savePath = getEnv( 'FILE_SAVE_PATH' );
const domain = ( function ( domain ) {
	return domain.match( /^https?:\/\// ) ? domain : 'https://' + domain;
} ( getEnv( 'DOMAIN' ) ) );
const enableGroups = getEnv( 'ENABLE_GROUPS' ).split( ',' ).map( Number.parseInt );
const infoChannel = getEnv( 'INFO_CHANNEL' );

app.use(
	function ( req, res, next ) {
		res.on( 'finish', function () {
			logger.main.debug(
				'%s - %s %s HTTP/%s %d',
				req.headers.host,
				req.method,
				req.originalUrl,
				req.httpVersion,
				res.statusCode
			);
		} );
		return next();
	}
);

app.use( '/files', express.static( savePath ) );

type DocumentAble = TT.PhotoSize | TT.Sticker | TT.Audio | TT.Voice | TT.Video | TT.Document

type File = ( DocumentAble | TT.File ) & {
	file_type: 'photo' | 'sticker' | 'audio' | 'voice' | 'video' | 'document';
};

function getFileIds( { message } : NarrowedContext<Context, TT.Update.MessageUpdate> ): File | false {
	if ( 'photo' in message ) {
		let sz = 0;
		let tmp: TT.PhotoSize | undefined = undefined;
		for ( const p of message.photo ) {
			if ( tmp === undefined || p.file_size && p.file_size > sz ) {
				tmp = p;
				sz = p.file_size || 0;
			}
		}

		if ( tmp ) {
			return {
				file_type: 'photo',
				...tmp
			};
		}
	}

	for ( const key of [ 'sticker', 'audio', 'voice', 'video', 'document' ] as const ) {
		if ( key in message ) {
			// @ts-expect-error TS7053
			const file: DocumentAble = message[ key ];
			return {
				file_type: key,
				...file
			};
		}
	}

	return false;
}

async function processFile( fileId: string ) {
	const url = await bot.telegram.getFileLink( fileId );

	const fileName =
		crypto.randomInt( Math.pow( 16, 8 ), Math.pow( 16, 9 ) ).toString( 16 ) +
		path.extname( url.href ).toLowerCase();
	
	await fetchStream(
		url,
		{
			method: 'GET'
		},
		function () {
			return fs.createWriteStream( path.join( savePath, fileName ) );
		}
	);
	logger.main.info( 'file ' + fileName + ' is created.' );

	return fileName;
}

function escape( formats: readonly string[], ...patterns: unknown[] ) {
	let result: string = '';

	const cFormats = Array.from( formats );
	const cPatterns = Array.from( patterns );

	while ( cPatterns.length > 0 ) {
		result += cFormats.shift();
		result += String( cPatterns.shift() )
			.replace( /&/g, '&amp;' )
			.replace( /</g, '&lt;' )
			.replace( />/g, '&gt;' );
	}
	return result + cFormats.join( '' );
}

bot.on( 'message', async function ( ctx ) {
	const thread = logger.createThread( 'onMessage' );
	thread.debug( `from: ${ ctx.from.id }, to: ${ ctx.chat.id }, messageId: ${ ctx.message.message_id }` );
	if ( !enableGroups.includes( ctx.chat.id ) ) {
		thread.debug( 'not in enableGroups, skip.' );
		return;
	}

	const file = getFileIds( ctx );

	if ( !file ) {
		thread.debug( 'not file found, skip.' );
		return;
	}

	let fileName: string;
	try {
		fileName = await processFile( file.file_id );
	} catch ( error ) {
		thread.error( util.inspect( error ) );
		ctx.sendMessage( 'Fail to resolve file.', {
			reply_to_message_id: ctx.message.message_id,
			allow_sending_without_reply: false
		} );
		return;
	}

	thread.debug( 'file name: ' + fileName );

	const message = [
		escape`from: ${ ctx.from.id }`,
		escape`to: ${ ctx.chat.id }`,
		escape`file: <code>${ file.file_id }</code> (unique: <code>${ file.file_unique_id }</code>)`,
		escape`url: ${ domain }/files/${ fileName }`,
		escape`raw: <code>${ JSON.stringify( file ) }</code>`
	].join( '\n' );

	ctx.sendMessage( message, {
		reply_to_message_id: ctx.message.message_id,
		allow_sending_without_reply: true,
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard( [
			[
				Markup.button.callback( 'Does file exist now?', 'exist:' + fileName )
			]
		] ).reply_markup
	} );

	bot.telegram.sendMessage( infoChannel, message, {
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard( [
			[
				Markup.button.callback( 'Delete it.', 'remove:' + fileName )
			]
		] ).reply_markup
	} );
} );

bot.action( /^exist:(?<file>[\da-f]+\.[a-z]+)$/, async function ( ctx ) {
	const thread = logger.createThread( 'onAction:exist' );
	const file = ctx.match.groups!.file;
	thread.debug( `id: ${ ctx.callbackQuery.id }, from: ${ ctx.callbackQuery.from.id }, rawMessage: ${
		ctx.callbackQuery.message ? `{ from: ${ ctx.callbackQuery.message.from!.id }, to: ${ ctx.callbackQuery.message.chat.id }, messageId: ${ ctx.callbackQuery.message.message_id } }` : null
	}, file: ${ file }` );
	try {
		await fs.promises.access( path.join( savePath, file ), fs.constants.R_OK );
		thread.debug( 'file is exist.' );
		return ctx.answerCbQuery( 'File ' + file + ' is exist.', {
			cache_time: 0
		} );
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) {
			thread.debug( 'file isn\'t exist.' );
			return ctx.answerCbQuery( 'File ' + file + ' isn\'t exist.', {
				cache_time: 0
			} );
		}
		thread.error( util.inspect( error ) );
		return ctx.answerCbQuery( 'Fail to resolve file.', {
			cache_time: 0
		} );
	}
} );

bot.action( /^remove:(?<file>[\da-f]+\.[a-z]+)$/, async function ( ctx ) {
	const thread = logger.createThread( 'onAction:remove' );
	const file = ctx.match.groups!.file;
	thread.debug( `id: ${ ctx.callbackQuery.id }, from: ${ ctx.callbackQuery.from.id }, rawMessage: ${
		ctx.callbackQuery.message ? `{ from: ${ ctx.callbackQuery.message.from?.id ?? ctx.callbackQuery.message.sender_chat?.id ?? '' }, to: ${ ctx.callbackQuery.message.chat.id }, messageId: ${ ctx.callbackQuery.message.message_id } }` : null
	}, file: ${ file }` );
	const message = ctx.callbackQuery.message;
	if ( !message ) {
		thread.warn( 'message is null.' );
		return ctx.answerCbQuery( 'Internal error.', {
			cache_time: 0
		} );
	}
	let isExist = true;
	try {
		await fs.promises.access( path.join( savePath, file ), fs.constants.R_OK | fs.constants.W_OK );
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) {
			thread.debug( 'file has been removed.' );
			isExist = false;
		} else {
			thread.error( util.inspect( error ) );
			return ctx.answerCbQuery( 'Fail to resolve file ' + file + ' .', {
				cache_time: 0
			} );
		}
	}
	if ( isExist ) {
		try {
			await fs.promises.rm( path.join( savePath, file ) );
			logger.main.info( 'file ' + file + ' is removed.' );
		} catch ( error ) {
			// ENOENT has checked.
			thread.error( util.inspect( error ) );
			return ctx.answerCbQuery( 'Fail to resolve file ' + file + ' .' );
		}
	}
	const promises: Promise<unknown>[] = [];
	if ( message.date * 1000 < Date.now() - 48 * 3600 * 1000 ) {
		thread.debug( 'channel message is too old to delete.' );
		promises.push( bot.telegram.editMessageText(
			ctx.callbackQuery.from.id,
			message.chat.id,
			undefined,
			'File ' + file + ' has been removed.'
		) );
	} else {
		thread.debug( 'delete message.' );
		promises.push( bot.telegram.deleteMessage( message.chat.id, message.message_id ) );
	}
	promises.push( ctx.answerCbQuery( isExist ? 'Delete ' + file + ' success.' : 'File' + file + ' has been removed.', {
		show_alert: true,
		cache_time: 3600
	} ) );
	return Promise.all( promises );
} );

bot.catch( function ( error ) {
	logger.main.error( util.inspect( error ) );
} );

const webHookPath = '/webhook' + crypto.randomInt( Math.pow( 16, 8 ), Math.pow( 16, 9 ) ).toString( 16 );
app.use( await bot.createWebhook( {
	domain: domain,
	path: webHookPath
} ) );

const server = app.listen( Number.parseInt( getEnv( 'PORT', true ) || '0', 10 ), function () {
	let address = server.address();
	if ( address === null ) {
		address = '';
	} else if ( typeof address === 'object' ) {
		address = util.format( 'IP: %s, PORT: %s', address.address, address.port );
	}
	logger.main.info( 'Server Start At %s.', address );
	logger.main.info( 'Telegraf webhook Start At %s%s.', domain, webHookPath );
} );

