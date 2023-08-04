"use strict";

const EventEmitter = require("events");

//	Class: The `DataCollectorServer` class provides the necessary facilities to launch a loggin server.
//	Events: `DataCollector` emits the following events:
//		* `"info"`, arguments: `message`
//		* `"error"`, arguments: `ncode, message, ex`
//	See also: `DataCollectorHttpProxy`.
class DataCollectorServer extends EventEmitter
{
	//	Constructor: Creates a new instance of the `DataCollectorServer` class.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.host: string` - required; a host name or IP address to listen on, e.g. `"0.0.0.0"`.
	//	Parameter: `par.port: uint` - required; an HTTP port to listen on, e.g. `9666`.
	//	Parameter: `par.createDataCollector(sourceKey: string): DataCollector | DataCollectorHttpProxy | { feed(targetStats, hit): void, enabled: boolean, isBucketEnabled(bucketKey): boolean }` - 
	//		required; a callback used by the `DataCollectorServer` to instanciate new data collector instances; for custom implementations, see `DataCollector` and `DataCollectorHttpProxy` for 
	//		implementation details.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.host) throw new Error(`Argument is null: "par.host".`);
		if (!par.port) throw new Error(`Argument is null: "par.port".`);
		if (!par.createDataCollector) throw new Error(`Argument is null: "par.createDataCollector".`);

		this.host = par.host;
		this.port = par.port;
		this.createDataCollector = par.createDataCollector;

		this.dataCollectors = {};
	}

	//	Function: Fires the "info" event whenever operation information is available.
	//	Parameter: `message: string` - additional details about the error.
	onInfo(message)
	{
		this.emit("info", message);
	}

	//	Function: Fires the "error" event whenever a recoverable exception occurs.
	//	Parameter: `ncode: number` - a unique identifier for the codepoint where the error was intercepted.
	//	Parameter: `ex: Error` - the exception instance.
	//	Parameter: `message: string` - additional details about the error.
	onError(ncode, message, ex)
	{
		this.emit("error", ncode, message, ex);
	}

	//	Function: `run(par: { getSourceCallback(req, res): string })` - Start the logging server.
	//	Parameter: `par.getSourceCallback(req, res): string` - implement this callback to provide custom `sourceKey` extraction logic for incoming requests, for Ex. from query string or X- headers
	//		added via nginx.
	//	Endpoints:
	//		- `/feed`
	//	Remarks:
	//		The default `sourceKey` extraction logic for incoming requests relies on`connection.remoteAddress || req.socket.remoteAddress || connection.socket.remoteAddress`.
	//		The resulting source key combines the extracted source key with `req.body.sourceKey` if present.
	//		`bodyParser` limits the incoming requests to 31MB.
	run(par)
	{
		const getSourceCallback = par ? par.getSourceCallback : null;

		process.on('uncaughtException', (err, origin) => this.onError(47563845, origin, err));

		const express = require('express');
		const methodOverride = require('method-override');
		const bodyParser = require('body-parser');

		const app = express();

		app.use(methodOverride());
		app.use(bodyParser.json({
			limit: '31mb'
		}));
		app.use(bodyParser.urlencoded({
			extended: true,
			limit: '31mb'
		}));

		app.post('/feed', function (req, res)
		{
			let sourceKey;
			if (getSourceCallback)
			{
				sourceKey = getSourceCallback(req, res) || "";
			}
			else
			{
				const connection = req.connection || {};
				const socket = req.socket || connection.socket || {};
				sourceKey = connection.remoteAddress || socket.remoteAddress || "";
			}
			sourceKey = sourceKey.replace(/\D/g, '.');
			if (req.body.sourceKey)
			{
				const strippedSourceKey = req.body.sourceKey.replace(/([^a-z0-9_\-]+)/gi, "-");
				sourceKey += "-" + strippedSourceKey;
			}
			this._ensureDataCollector(sourceKey).feed(req.body.targetStats, req.body.hit);
			res.end("");
		}.bind(this));

		app.listen(this.port, this.host);
		this.onInfo(`Data collector server listenig on ${JSON.stringify(this.host)}:${JSON.stringify(this.port)}`);

		return this;
	}

	//	Function: `printConfigurationLines(): string` - returns a string containing a formatted multiline list of all effective configuration settings related to the server and to profiling.
	//	Returns: a string containing a formatted multiline list of all effective configuration settings related to the server and to profiling, e.g.
	//	```
	//	```
	//	Remarks: "preconf" - a hardcoded setting that cannot be modified at run time; "runtime" - a setting can be modified at run time.
	printConfigurationLines()
	{
		let sb = "";
		sb += `*preconf* host = ${JSON.stringify(this.host)}`;
		sb += "\n" + `*preconf* port = ${JSON.stringify(this.port)}`;
		for (let length = this.dataCollectors.length, i = 0; i < length; ++i)
		{
			sb += "data collector\n=================================";
			const dataCollector = this.dataCollectors[i];
			const outcome = dataCollector.runtimeConfigurator.getConfigurationLines("runtimeConfigurator").concat(dataCollector.getConfigurationLines("dataCollector"));
			for (let length = outcome.length, i = 0; i < length; ++i)
			{
				const item = outcome[i];
				sb += "\n" + `*${item.type}* ${item.setting} = ${JSON.stringify(item.value)}`;
				item.explanation && (sb += ` (${item.explanation})`);
			}
		}
		return sb;
	}

	_ensureDataCollector(sourceKey)
	{
		const result = this.dataCollectors[sourceKey];
		if (result) return result;
		return this.dataCollectors[sourceKey] = this.createDataCollector(sourceKey);
	}
}

module.exports = DataCollectorServer;
module.exports.DataCollectorServer = module.exports;
