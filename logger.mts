import util = require( 'node:util' );

export type LogFunc = ( message: unknown, ...optionalParams: unknown[] ) => void;

function makeLogger(
	callFunc: LogFunc = console.log,
	stopFunc: ( () => boolean ) | false = false,
	format: string = '',
	patterns: unknown[] = []
) {
	return function ( message: unknown, ...optionalParams: unknown[] ) {
		if ( stopFunc && stopFunc() ) {
			return;
		}
		return callFunc(
			format + ' %s',
			...patterns,
			util.format( message, ...optionalParams )
		);
	};
}

function internalLog(
	level: 'debug' | 'info' | 'warn' | 'error',
	stopFunc: ( () => boolean ) | false = false
) {
	return makeLogger(
		console[ level ],
		stopFunc,
		'[%s] [%s]',
		[ new Date().toISOString(), level.toUpperCase() ]
	);
}

const baseLogger = {
	debug: internalLog(
		'debug',
		function () {
			return !process.env.DEBUG;
		}
	),
	info: internalLog( 'info' ),
	warn: internalLog( 'warn' ),
	error: internalLog( 'error' )
};

const lastThreadIds = new Map<string, number>();

function getLogger( name: string, callFunc: LogFunc = baseLogger.info ) {
	return makeLogger(
		callFunc,
		false,
		'[%s]',
		[ name ]
	);
}

export function createThread( threadName: string ) {
	const id = ( lastThreadIds.get( threadName ) || 0 ) + 1;
	lastThreadIds.set( threadName, id );

	const name = util.format( '%s:%d', threadName, id );

	return {
		debug: getLogger( name, baseLogger.debug ),
		info: getLogger( name, baseLogger.info ),
		warn: getLogger( name, baseLogger.warn ),
		error: getLogger( name, baseLogger.error ),
	};
}

export const main =  {
	debug: getLogger( 'main', baseLogger.debug ),
	info: getLogger( 'main', baseLogger.info ),
	warn: getLogger( 'main', baseLogger.warn ),
	error: getLogger( 'main', baseLogger.error ),
};
