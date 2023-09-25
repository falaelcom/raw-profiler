"use strict";

//	TODO:
//		- change the interface of raw-profiler
//			- reimagine instanciation and configuration of different components
//				- introduce configuration templates that cover settings for multiple components (currently covered by `__pfconfig` as one huge json with invisible interpretation rules, such as - this property is used only with data collector http proxy)
//				- introduce configuration filed type ("preconf", "runtime", "hardcod", "remote") in configuration templates
//				- streamline run-time configuration changes through configuration templates; streamline all configuration through configuration templates
//			- create no default instances
//		+ provide same initial configuration options from code (the`__pfconfig` function call) and from file (the `__pfconfig` file JSON).
//			+ design a strategy for profiling of multiple npm modules that create separate profiler instances
//			- examine the `__pfenabled` effect on logging server
//		- make sure all open hits end before the profiler/bucket enabled state changes
//		- there are several flags such as `isRefreshing`; enumerate all flags; if necessary, add code to make sure that no exception or error might leave such flags up forever
//		- the CPU usage is being calculated based on OS and not node js process CPU stats (older node js versions lack a required api). Desired solution - detect node js version and enable node js process CPU stats when possible.
//		- make system stats modular; provide modules for CPU/RAM, disk space, log and archive size, mongodb server info, rabbitmq info.
//		- allow for formatting override
//		- force `__pfflush` to wait for any archiving started by the file logger before invoking the callback
//		- allow user to completely override any console logging done by raw-profiler
//		- do sth with the default instances and console logging, including letting the user configure console logging instead of using `console.log` directly
//		- implement a new profiler http proxy /data collector server pair that doesn't store any state on the application server and
//			instead proxies all single `__pfbegin/__pfend/__pflog/__pfflush` calls directly to the data collector server
//		- possible problem: why so often log files get archived without new log files being created ? seems at odds that so often archiving happens precisely
//	DEBT:
//	    -- migrate to async/await syntax
//		-- replace all `.bind` calls with lambda functions
//		-- cache `hit.bucketKey + "*" + hit.key` in the hit
//		-- get rid of all `fs.*Sync` calls in FileLogger; currently synch calls only affect the logging server, and the task is not of highest priority
//		-- add parameter value validation throughout the code
//		-- migrate array sbs to string sbs
//		-- refactor all event argument lists to start with `sender`

const EventEmitter = require('events');
EventEmitter.defaultMaxListeners = 666;


const { EVerbosity } = require("./lib/EVerbosity.js");
const { Utility } = require("./lib/Utility.js");
const { RuntimeConfigurator } = require("./lib/RuntimeConfigurator.js");
const { RemoteRuntimeConfigurator } = require("./lib/RemoteRuntimeConfigurator.js");
const { ConsoleLogger } = require("./lib/ConsoleLogger.js"); 
const { FileLogger } = require("./lib/FileLogger.js");
const { DataCollector } = require("./lib/DataCollector.js");
const { DataCollectorHttpProxy } = require("./lib/DataCollectorHttpProxy.js"); 
const { MachineStats } = require("./lib/MachineStats.js");
const { Profiler } = require("./lib/Profiler.js");
const { DataCollectorServer } = require("./lib/DataCollectorServer.js");
const { Debouncer } = require("./lib/Debouncer.js");

//#region Interface
const _onInfo = (source, message) => console.log("[raw-profiler]", `[${source}]`, message);
const _onError = (source, ncode, message, ex) => console.error("[raw-profiler]", `[${source}]`, ncode, message, ex);
const _onConfigurationChanged = (target, key, value, oldValue, source, ctimes) => console.log("[raw-profiler]", `[${target}]`, `Runtime configuration field "${key}" changed via ${source} from ${JSON.stringify(oldValue)} to ${JSON.stringify(value)}.`);
const _onConfigurationRefreshFinished = (hasChanged) => hasChanged && console.log("[raw-profiler] =================================\n" + "[raw-profiler] Effective config\n[raw-profiler] =================================\n" + (defaultServer ? defaultServer.printConfigurationLines() : __pf.instance.printConfigurationLines()));

//	The `runtimeConfigurator` instance is a shared between all configuration targets.
let runtimeConfigurator = new RuntimeConfigurator(
{
	commandFilePath: "__pfenable",
	configurationFilePath: "__pfconfig",
	refreshSilenceTimeoutMs: 5000,
});
runtimeConfigurator.on("refreshFinished", _onConfigurationRefreshFinished);
runtimeConfigurator.on("configurationChanged", (...args) => _onConfigurationChanged("runtime-configurator", ...args));

let defaultConsoleLogger = null;
let defaultFileLogger = null;
let defaultDataCollector = null;
let defaultProfiler = null;
let defaultServer = null;

//	Object: Publishes more profiling and configuration facilities beyond the `__pf*` function family.
const __pf =
{
	//	Field: `instance: Profiler` - The single instance of `Profiler`.
	get instance()
	{
		if (defaultProfiler) return defaultProfiler;
		defaultProfiler = new Profiler(this.DefaultDataCollector);
		return defaultProfiler;
	},

	//	Field: `osResourceStats: object` - a shorcut to `MachineStats.osResourceStats`.
	get osResourceStats()
	{
		return MachineStats.osResourceStats;
	},

	//	Field: `DefaultFileLogger: FileLogger` - a preconfigured default `FileLogger` instance.
	get DefaultFileLogger()
	{
		if (defaultFileLogger) return defaultFileLogger;
		defaultFileLogger = new FileLogger(
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				verbosity: EVerbosity.Full,
				logPath: "__pflogs",
				archivePath: "__pfarchive",
				maxLogSizeBytes: 0,				//	archiving disabled
				maxArchiveSizeBytes: 0,			//  archive trimming disabled
				logRequestArchivingModulo: 25,
			},
			sourceKey: "",
		});
		defaultFileLogger.on("info", (...args) => _onInfo("default-file-logger", ...args));
		defaultFileLogger.on("error", (...args) => _onError("default-file-logger", ...args));
		defaultFileLogger.on("configurationChanged", (...args) => _onConfigurationChanged("default-file-logger", ...args));
		return defaultFileLogger;
	},

	//	Field: `DefaultConsoleLogger: ConsoleLogger` - a preconfigured default `ConsoleLogger` instance.
	get DefaultConsoleLogger()
	{
		if (defaultConsoleLogger) return defaultConsoleLogger;
		defaultConsoleLogger = new ConsoleLogger(
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				verbosity: EVerbosity.Full,
			}
		});
		defaultConsoleLogger.on("configurationChanged", (...args) => _onConfigurationChanged("default-console-logger", ...args));
		return defaultConsoleLogger;
	},

	//	Field: `DefaultDataCollector: DataCollector` - a preconfigured default `DataCollector` instance that uses `ConsoleLogger`.
	get DefaultDataCollector()
	{
		if (defaultDataCollector) return defaultDataCollector;
		defaultDataCollector = new DataCollector(
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				sortColumn: "maxMs",
			},
			logger: this.DefaultConsoleLogger,
			flushDelayMs: 0,
		});
		defaultDataCollector.on("info", (...args) => _onInfo("default-data-collector", ...args));
		defaultDataCollector.on("error", (...args) => _onError("default-data-collector", ...args));
		defaultDataCollector.on("configurationChanged", (...args) => _onConfigurationChanged("default-data-collector", ...args));
		return defaultDataCollector;
	},

	//	Function: `createDataCollectorServer(par: void | object)` - creates and configures a new `DataCollectorServer` instance.
	//	Parameter:
	//	```
	//	par:				//	optional
	//	{
	//		host: string,	//	optional, defaults to `"0.0.0.0"`; a host name or IP address to listen on, e.g. `"0.0.0.0"`.
	//		port: uint,		//	optional, defaults to `9666`; an HTTP port to listen on, e.g. `9666`.
	//		fileLogger:		//	optional
	//		{
	//			verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
	//			logPath: string,					//	optional, defaults to `"__pflogs"`
	//			archivePath: string,				//	optional, defaults to `"__pfarchive"`
	//			maxLogSizeBytes: uint,				//	optional, defaults to `200 * 1024 * 1024` (200MB); use `0` to disable log archiving
	//			maxArchiveSizeBytes: uint,			//	optional, defaults to `1024 * 1024 * 1024` (1GB); use `0` to disable archive collection trimming
	//			logRequestArchivingModulo: uint,	//	optional, defaults to `100`; use `0` to disable log archiving
	//		},
	//		dataCollector:	//	optional
	//		{
	//			sortColumn: stirng,					//	optional, defaults to `"maxMs"`
	//			flushDelayMs: uint,					//	optional, defaults to `0`
	//		}
	//	}
	//	```
	//	Returns: the newly created and configured `DataCollectorServer` instance.
	createDataCollectorServer: function (par)
	{
		if (defaultServer) throw new Error(`Only one server instance is supported.`);

		par = par || {};

		const result = new DataCollectorServer(
		{
			runtimeConfigurator,
			host: par.host || "0.0.0.0",
			port: par.port || 9666,
			createDataCollector(sourceKey, currentConfig)
			{
				const fileLogger = new FileLogger(
				{
					runtimeConfigurator,
					runtimeInitial:
					{
						verbosity: currentConfig?.["logger.verbosity"] || par.fileLogger?.verbosity || EVerbosity.Full,
						logPath: currentConfig?.["logger.logPath"] || par.fileLogger?.logPath || "__pflogs",
						archivePath: currentConfig?.["logger.archivePath"] || par.fileLogger?.archivePath || "__pfarchive",
						maxLogSizeBytes: !isNaN(currentConfig?.["logger.maxLogSizeBytes"]) ? currentConfig?.["logger.maxLogSizeBytes"] :
							(par.fileLogger && !isNaN(par.fileLogger.maxLogSizeBytes)) ? par.fileLogger.maxLogSizeBytes : 200 * 1024 * 1024, //  200MB
						maxArchiveSizeBytes: !isNaN(currentConfig?.["logger.maxArchiveSizeBytes"]) ? currentConfig?.["logger.maxArchiveSizeBytes"] :
							(par.fileLogger && !isNaN(par.fileLogger.maxArchiveSizeBytes)) ? par.fileLogger.maxArchiveSizeBytes : 1024 * 1024 * 1024,	//  1GB
						logRequestArchivingModulo: !isNaN(currentConfig?.["logger.logRequestArchivingModulo"]) ? currentConfig?.["logger.logRequestArchivingModulo"] :
							(par.fileLogger && !isNaN(par.fileLogger.logRequestArchivingModulo)) ? par.fileLogger.logRequestArchivingModulo : 100,
					},
					sourceKey,
				});
				fileLogger.on("info", (...args) => _onInfo(`file-logger:${sourceKey}`, ...args));
				fileLogger.on("error", (...args) => _onError(`file-logger:${sourceKey}`, ...args));
				fileLogger.on("configurationChanged", (...args) => _onConfigurationChanged(`file-logger:${sourceKey}`, ...args));

				const arg =
				{
					runtimeConfigurator,
					runtimeInitial:
					{
						sortColumn: currentConfig?.["sortColumn"] || par.dataCollector?.sortColumn || "maxMs",
					},
					logger: fileLogger,
					flushDelayMs: (par.dataCollector && !isNaN(par.dataCollector.flushDelayMs)) ? 
					par.dataCollector.flushDelayMs : 0,
				};
				if (currentConfig) for (const key in currentConfig) (key.indexOf("bucket.") === 0) && (arg.runtimeInitial[key] = currentConfig[key]);
				const result = new DataCollector(arg);
				result.on("info", (...args) => _onInfo(`data-collector:${sourceKey}`, ...args));
				result.on("error", (...args) => _onError(`data-collector:${sourceKey}`, ...args));
				result.on("configurationChanged", (...args) => _onConfigurationChanged(`data-collector:${sourceKey}`, ...args));

				return result;
			},
		});
		result.on("info", (...args) => _onInfo("data-collector-server", ...args));
		result.on("error", (...args) => _onError("data-collector-server", ...args));
		result.on("configurationChanged", (...args) => _onConfigurationChanged(`data-collector-server`, ...args));

		defaultServer = result;

		return result;
	},

	//	Object: A collection of utility functions to aid the building of profiling hit point keys.
	utility:
	{
		//	Function: `getKeysText(obj: object): string` - prints into a string a coma-separated list of the enumerable property names of `obj`.
		//	Parameter: `obj: object` - the input object to format.
		//	Returns: a coma-separated list of the enumerable property names of `obj`, e.g. `{a:1, b:"B", c:true}` will produce `"a,b,c"`.
		//	Remarks: This function effectively serializes the top-level of the object schema. Used when building profile hit keys.
		getKeysText: function (obj)
		{
			try
			{
				return Utility.getKeysText(obj);
			}
			catch (ex)
			{
				console.error(3456348760, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},

		//	Function: `stripStringify(obj: object, stripFieldPaths: [string]): string` - stringifies `obj` via `JSON.stringify` while replacing all values at the specified `stripFieldPaths` 
		//		by `"(stripped by raw-profiler)"`.
		//	Parameter: `obj: object` - the input object to stringify.
		//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"`.
		//	Returns: a string generated by `JSON.stringify` with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"`.
		//	Remarks:
		//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
		//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
		stripStringify: function (obj, stripFieldPaths)
		{
			try
			{
				return Utility.stripStringify(obj, stripFieldPaths);
			}
			catch (ex)
			{
				console.error(3456348761, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},

		//	Function: `stripStringifyArray(arr: array, stripFieldPaths: [string]): string` - stringifies `arr` while replacing all values at the specified `stripFieldPaths`
		//		by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
		//	Parameter: `arr: array` - the input arr to stringify.
		//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"` (WARNING: at this time stripping in arrays is not implemented).
		//	Returns: the array serialized as JSON with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
		//	Remarks:
		//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
		//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
		//		As a result, at this time this method is unable to strip anyting.
		stripStringifyArray: function (arr, stripFieldPaths)
		{
			try
			{
				return Utility.stripStringifyArray(arr, stripFieldPaths);
			}
			catch (ex)
			{
				console.error(3456348762, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},
	},
};

//	Function: `__pfconfig(par: object): void` - Reconfigures the `Profiler` single instance.
//	Parameter:
//	```
//		par:
//		{
//			useRemoteConfig: boolean,						//	optional, defaults to false; only has meaning with DataCollectorHttpProxy; if set to `true` will cause the runtime configuration to be acquired remotely from the data collector server, and the local `__pfenable` and `__pfconfig` files will be ignored, as well as the following configuration properties below: `commandFilePath`, `configurationFilePath`, `refreshSilenceTimeoutMs`; `initialEnabled` will determine whether the proxy will be processing feeds before the remote configuration has been acquired.
//			remoteConfigRequestTimeoutMs: uint,				//	optional, defaults to 5000; only applicable with useRemoteConfig.
//			repeatOnRemoteConfigFailureIntervalMs: uint,	//	optional, defaults to 60000; only applicable with useRemoteConfig.
//
//			initialEnabled: boolean,			//	optional, defaults to true; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
//			commandFilePath: string,			//	optional, defaults to "__pfenable"; the path to the runtime command file for raw-profiler, e.g. /home/user/__pfenable; the existance of the command file determines the enabled state of the raw-profiler; if there is no such file, the raw-profiler functionality is completely disabled except for testing for the command file existence.
//			configurationFilePath: string,		//	optional, defaults to "__pfconfig"; the path to the runtime configuration file for raw-profiler, e.g. /home/user/__pfconfig.
//			refreshSilenceTimeoutMs: uint,		//	optional, defaults to 5000; run-time configuration refresh-from-file attempts will be performed no more frequently than once every refreshSilenceTimeoutMs milliseconds.
//
//			create(className, config): object,	//	optional; if set will be called whenever a non-standard data collector or logger need to be created (see par.dataCollector.type and par.dataCollector.logger.type).
//			dataCollector:						//	optional, if not set __pf.DefaultDataCollector is used; configuration for a new data collector instance; if the provided value has no type propery, this value is assumed to be a data collector instance.
//			{
//				type: string,					//	optional, defaults to "DataCollector"; the class name to instanciate a new data collector from; can be "DataCollector", "DataCollectorHttpProxy" or a custom data collector; if a custom name is provided, a `par.create` callback must be provided as well that knows how to create a data collector instance based on this name.
//				config:							//	optional
//				{
//					//	with DataCollector
//					runtimeInitial:				//	optional; DataCollector uses the values specified as properties to this object as initial configuration.
//					{
//						sortColumn: string,		//	optional, defaults to "maxMs"
//						"buckets.*": ...		//	optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
//					},
//					logger:						//	optional, if not set __pf.DefaultConsoleLogger is used; configuration for a logger instance; if the provided value has no type propery, this value is assumed to be a logger instance.
//					{
//						type: string,			//	optional, defaults to "ConsoleLogger"; the class to instanciate a new logger from; can be "ConsoleLogger", "FileLogger" or a custom class/object implementing { logBuckets: function }; if a custom name is provided, a `par.create` callback must be provided as well that knows how to create a logger instance based on this name.
//						config:					//	optional
//						{
//							//	with ConsoleLogger
//							runtimeInitial:							//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//							{
//								verbosity: string,					//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//							},
//
//							//	with FileLogger
//							runtimeInitial:							//	optional; FileLogger uses the values specified as properties to this object as initial configuration.
//							{
//								verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
//								logPath: string,					//	optional, defaults to `"__pflogs"`
//								archivePath: string,				//	optional, defaults to `"__pfarchive"`
//								maxLogSizeBytes: uint,				//	optional, defaults to `0` (disabled); use `0` to disable log archiving
//								maxArchiveSizeBytes: uint,			//	optional, defaults to `0` (disabled); use `0` to disable archive collection trimming
//								logRequestArchivingModulo: uint,	//	optional, defaults to `25`
//								sourceKey: string,					//	optional, defaults to `""`
//							},
//						},
//					},
//					flushDelayMs: uint,					//	optional, defaults to 0; used as a parameter for a setTimeout before flushing the queues.
//
//					//	with DataCollectorHttpProxy
//					runtimeInitial:						//	required; DataCollectorHttpProxy uses the values specified as properties to this object as initial configuration.
//					{
//						uri: string,					//	required; DataCollectorHttpProxy will forward profiling data by sending HTTP requests to this URI until overwritten by the runtime configuration.
//						sourceKey: string,				//	required; this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to a single logging server until overwritten by the runtime configuration.
//						requestTimeoutMs: uint,			//	required; specifies a timeout for HTTP requests before abortion until overwritten by the runtime configuration.
//						failureTimeoutMs: uint,			//	required; specifies the time between reporting repeated HTTP request failures until overwritten by the runtime configuration.
//						"buckets.*": ...				//	optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
//					},
//				},
//			},
//		}
//	```
//	Alternative form - `par.logger` instead of `par.dataCollector` (assumes a data collector of type "DataCollector")
//	```
//		par:
//		{
//			...
//			logger:						//	optional, if not set __pf.DefaultConsoleLogger is used; configuration for a logger instance; if the provided value has no type propery, this value is assumed to be a logger instance
//			{
//				type: string,			//	optional, defaults to "ConsoleLogger"; the class to instanciate a new logger from; can be "ConsoleLogger", "FileLogger" or a custom class/object implementing { logBuckets: function }.
//				config:					//	optional
//				{
//					//	with ConsoleLogger
//					runtimeInitial:							//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//					{
//						verbosity: string,					//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//					},
//
//					//	with FileLogger
//					runtimeInitial:							//	optional; FileLogger uses the values specified as properties to this object as initial configuration.
//					{
//						verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
//						logPath: string,					//	optional, defaults to `"__pflogs"`
//						archivePath: string,				//	optional, defaults to `"__pfarchive"`
//						maxLogSizeBytes: uint,				//	optional, defaults to `0` (disabled); use `0` to disable log archiving
//						maxArchiveSizeBytes: uint,			//	optional, defaults to `0` (disabled); use `0` to disable archive collection trimming
//						logRequestArchivingModulo: uint,	//	optional, defaults to `25`
//						sourceKey: string,					//	optional, defaults to `""`
//					},
//				},
//			},
//		}
//	```
function __pfconfig(par)
{
	try
	{
		//	runtimeConfigurator
		if (par.useRemoteConfig)
		{
			runtimeConfigurator.removeAllListeners();
			runtimeConfigurator = new RemoteRuntimeConfigurator(
			{
				initialEnabled: par.initialEnabled,
				remoteConfigRequestTimeoutMs: par.remoteConfigRequestTimeoutMs,
				repeatOnRemoteConfigFailureIntervalMs: par.repeatOnRemoteConfigFailureIntervalMs,
			});
			runtimeConfigurator.on("refreshFinished", _onConfigurationRefreshFinished);
			runtimeConfigurator.on("configurationChanged", (...args) => _onConfigurationChanged("remote-runtime-configurator", ...args));
		}
		else
		{
			if (par.commandFilePath !== void 0 && par.commandFilePath !== null) runtimeConfigurator.commandFilePath = par.commandFilePath;
			if (par.configurationFilePath !== void 0 && par.configurationFilePath !== null) runtimeConfigurator.configurationFilePath = par.configurationFilePath;
			if (par.refreshSilenceTimeoutMs !== void 0 && par.refreshSilenceTimeoutMs !== null) runtimeConfigurator.refreshSilenceTimeoutMs = par.refreshSilenceTimeoutMs;
			if (par.initialEnabled !== void 0 && par.initialEnabled !== null) runtimeConfigurator.enabled = par.initialEnabled;
		}

		const default_dataCollector_config =
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				sortColumn: "maxMs",
			},
			flushDelayMs: 0,
		};
		const default_dataCollectorHttpProxy_config =
		{
			runtimeConfigurator,
		};
		const default_consoleLogger_config =
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				verbosity: EVerbosity.Full,
			},
		};
		const default_fileLogger_config =
		{
			runtimeConfigurator,
			runtimeInitial:
			{
				verbosity: EVerbosity.Full,
				logPath: "__pflogs",
				archivePath: "__pfarchive",
				maxLogSizeBytes: 0,
				maxArchiveSizeBytes: 0,
				logRequestArchivingModulo: 25,
				sourceKey: "",
			},
		};

		//	dataCollector, logger
		const createNewDataCollector = !!(par.dataCollector?.type || par.logger);
		const createDataCollectorNewLogger = !!par.dataCollector?.logger?.type;
		const createNewLogger = !!(!createDataCollectorNewLogger && par.logger?.type);
		const useDataCollectorInstance = !!(par.dataCollector && !par.dataCollector.type);
		const useDataCollectorLoggerInstance = !!(par.dataCollector?.logger && !par.dataCollector?.logger.type);
		const useLoggerInstance = !!(!useDataCollectorLoggerInstance && par.logger && !par.logger.type);

		let logger;
		if (createNewLogger || createDataCollectorNewLogger)
		{
			const loggerDef = createNewLogger ? par.logger : par.dataCollector.logger;
			switch (loggerDef.type)
			{
				case "ConsoleLogger":
					logger = new ConsoleLogger(__blend(default_consoleLogger_config, loggerDef.config));
					break;
				case "FileLogger":
					logger = new FileLogger(__blend(default_fileLogger_config, loggerDef.config));
					break;
				default:
					if (!create) throw new Error(`A "create" callback is required to instanciate a profiler logger of type ${JSON.stringify(loggerDef.type)}.`);
					logger = create(loggerDef.type, loggerDef.config);
					break;
			}
			__pf.instance.dataCollector?.logger?.removeAllListeners("info");
			__pf.instance.dataCollector?.logger?.removeAllListeners("error");
			__pf.instance.dataCollector?.logger?.removeAllListeners("configurationChanged");
			logger.on("info", (...args) => _onInfo("file-logger", ...args));
			logger.on("error", (...args) => _onError("file-logger", ...args));
			logger.on("configurationChanged", (...args) => _onConfigurationChanged("file-logger", ...args));
		}
		else if (useLoggerInstance || useDataCollectorLoggerInstance)
		{
			logger = useLoggerInstance ? par.logger : par.dataCollector.logger;
			__pf.instance.dataCollector?.logger?.removeAllListeners("info");
			__pf.instance.dataCollector?.logger?.removeAllListeners("error");
			__pf.instance.dataCollector?.logger?.removeAllListeners("configurationChanged");
			logger.on("info", (...args) => _onInfo("file-logger", ...args));
			logger.on("error", (...args) => _onError("file-logger", ...args));
			logger.on("configurationChanged", (...args) => _onConfigurationChanged("file-logger", ...args));
		}
		else logger = __pf.DefaultConsoleLogger;

		if (createNewDataCollector)
		{
			let dataCollector;
			switch (par.dataCollector?.type)
			{
				case void 0:
				case "DataCollector":
					dataCollector = new DataCollector(__blend(default_dataCollector_config, par.dataCollector?.config || {} , { logger }));
					break;
				case "DataCollectorHttpProxy":
					dataCollector = new DataCollectorHttpProxy(__blend(default_dataCollectorHttpProxy_config, par.dataCollector.config));
					break;
				default:
					if (!par.create) throw new Error(`A "par.create" callback is required to instanciate a profiler data collector of type ${JSON.stringify(par.dataCollector.type)}.`);
					dataCollector = par.create(par.dataCollector.type, par.dataCollector.config);
					break;
			}
			__pf.instance.dataCollector?.removeAllListeners("info");
			__pf.instance.dataCollector?.removeAllListeners("error");
			__pf.instance.dataCollector?.removeAllListeners("configurationChanged");
			dataCollector.on("info", (...args) => _onInfo("data-collector", ...args));
			dataCollector.on("error", (...args) => _onError("data-collector", ...args));
			dataCollector.on("configurationChanged", (...args) => _onConfigurationChanged("data-collector", ...args));
			return __pf.instance.setDataCollector(dataCollector);
		}
		else if (useDataCollectorInstance)
		{
			const dataCollector = par.dataCollector;
			__pf.instance.dataCollector?.removeAllListeners("info");
			__pf.instance.dataCollector?.removeAllListeners("error");
			__pf.instance.dataCollector?.removeAllListeners("configurationChanged");
			dataCollector.on("info", (...args) => _onInfo("data-collector", ...args));
			dataCollector.on("error", (...args) => _onError("data-collector", ...args));
			dataCollector.on("configurationChanged", (...args) => _onConfigurationChanged("data-collector", ...args));
			return __pf.instance.setDataCollector(dataCollector);
		} 
		else return __pf.DefaultDataCollector;
	}
	catch (ex)
	{
		console.error("[raw-profiler]", 3456348758, "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
	}

	function __blend(...args)
	{
		let result = args[0];
		for (let length = args.length, i = 1; i < length; ++i) result = __do(result, args[i]);
		return result;
		
		function __do(left, right)
		{
			let result = {};

			// Iterate over the keys in the left object
			for (let key in left)
			{
				// If the key is also in the right object and both values are objects, blend them
				if (right.hasOwnProperty(key) && typeof left[key] === 'object' && typeof right[key] === 'object')
				{
					result[key] = blend(left[key], right[key]);
				} else if (right.hasOwnProperty(key))
				{
					// If the key is in the right object, use the value from the right object
					result[key] = right[key];
				} else
				{
					// Otherwise, use the value from the left object
					result[key] = left[key];
				}
			}

			// Iterate over the keys in the right object to find any keys not in the left object
			for (let key in right)
			{
				if (!left.hasOwnProperty(key))
				{
					result[key] = right[key];
				}
			}

			return result;
		}
	}
}

//	Function: `__pfenabled(bucketKey: string)` - gets the enabled status for the profiling bucket specified by the provided `bucketKey`.
//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
//	Returns: `true` if both the data collector currently in use and the specific bucket profiling are enabled, otherwise returns `false`.
//	Remarks: 
//		This function considers also the enabled state of the data collector currently in use (`this.dataCollector`).
//		This function never throws an exception.
function __pfenabled(bucketKey)
{
	return __pf.instance.isEnabled(bucketKey);
}

//	Function: `__pfbegin(bucketKey: string, key: string, text: string): object` - creates, registers and returns a new profiling hit.
//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
//	Parameter: `key: string` - a key for grouping of profiling data at statistics level within a bucket; multiple profiling hits (i.e. `__pfbegin`/`__pfend` pairs) for the same
//		`(bucketKey, key)` pair are aggregated and analysed statistically and produce stats such as minimum, average, maximum and total execution time.
//	Parameter: `text: string` - a text used as a title for profiling stats tables with `EVerbosity.Brief` and `EVerbosity.Full` and as a logging line with `EVerbosity.Log`;
//		the `__pfend` call can append a postfix text to this text.
//	Returns: An object representing current state required for the measurements for hit profiling as returned by `ProfilerTarget.hit(title, hitCount, openHitsCount)`;
//		see `ProfilerTarget.hit(title, hitCount, openHitsCount)` docs for details.
//	Remarks: 
//		This function never throws an exception.
//		Always use `Utility.stripStringify` before logging objects via `text` to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
function __pfbegin(bucketKey, key, text)
{
	return __pf.instance.begin(bucketKey, key, text);
}

//	Function: `__pfend(hit: object, postfix: string): null` - calculates profiling data and finalizes a profiling `hit`; initiates the logging of the collected data.
//	Parameter: `hit: object` - required; the result of the corresponding `__pfbegin` call.
//	Parameter: `postfix: string` - optional; appended to the `text` from the corresponding `__pfbegin` call.
//	Returns: Always returns `null`. Recommended as a shortcut for releasing the current profiler hit's state, e.g.:
//	```
//	    let hit = __pfbegin("bucketKey1", "key1" [, "text"]);
//		//	... code to profile
//		hit = __pfend(hit [, " append to text"]);
//	```
//	Remarks: 
//		This function never throws an exception.
//		Always use `Utility.stripStringify` before logging objects via `postfix` to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
function __pfend(hit, postfix)
{
	return __pf.instance.end(hit, postfix);
}

//	Function: `__pfdiscard(hit: object): null` - remove the `hit` from the ON-time stats.
//	Parameter: `hit: object` - required; the result of the corresponding `__pfbegin` call.
//	Returns: Always returns `null`. Recommended as a shortcut for releasing the current profiler hit's state, e.g.:
//	```
//	    let hit = __pfbegin("bucketKey1", "key1" [, "text"]);
//		//	... code to profile
//		hit = __pfdiscard(hit [, " append to text"]);
//	```
//	Remarks: 
//		This function never throws an exception.
function __pfdiscard(hit)
{
	return __pf.instance.discard(hit);
}

//	Function: `__pflog(bucketKey: string, ...args): void` - writes `args` as text to the profiling logs without creating a hit point.
//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
//	Parameter: `...args` - arguments will be joined via `args.join(" ")` and the result will be used as text for the logging operaiton.
//	Remarks: 
//		This function never throws an exception.
//		Always use `Utility.stripStringify` before logging objects via `text` to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
//		This function is a shorthand for `__pfend(__pfbegin(bucketKey, "PFLOG", text));`
function __pflog(bucketKey, ...args)
{
	return __pf.instance.log(bucketKey, args.join(" "));
}

function __pfschema(obj)
{
	try
	{
		return __pf.utility.getKeysText(obj);
	}
	catch (ex)
	{
		_onError("__pfschema", 98475643, "Unexpected error.", ex);
		return `(ERROR __pfschema, see server logs for details: ${ex.message})`;
	}
}

function __pfjson(obj, stripFieldPaths = null)
{
	try
	{
		if (stripFieldPaths) return __pf.utility.stripStringify(obj, stripFieldPaths);
		return JSON.stringify(obj);
	}
	catch (ex)
	{
		_onError("__pfjson", 98875643, "Unexpected error.", ex);
		return `(ERROR __pfjson, see server logs for details): ${ex.message}`;
	}
}

//	Function: `__pfflush(callback(err: object): void, stopLogging: boolean): void` - immediately initiates the process of flushing the queues to the logger.
//	Parameter: `callback(err): void` - required; a callback that is called when flushing finishes.
//	Parameter: `stopLogging: boolean` - optional, defaults to `true`; if set to true, the current data collector immediately starts ignoring any new data ensuring that there won't be new entries
//		enqueued. There's no way to resume enqueueing.
//	Remarks: 
//		This method is intended to enable flushing of the queues on app termination.
//		This function never throws an exception.
function __pfflush(callback, stopLogging = true)
{
	return __pf.instance.flush(callback, stopLogging);
}

MachineStats.startMonitoring();

module.exports =
{
	globals()
	{
		global.__pf = __pf;
		global.__pfconfig = __pfconfig;
		global.__pfenabled = __pfenabled;
		global.__pfbegin = __pfbegin;
		global.__pfend = __pfend;
		global.__pfdiscard = __pfdiscard;
		global.__pflog = __pflog;
		global.__pfschema = __pfschema;
		global.__pfjson = __pfjson;

		return module.exports;
	}
};
module.exports.__pf = __pf;
module.exports.__pfconfig = __pfconfig;
module.exports.__pfenabled = __pfenabled;
module.exports.__pfbegin = __pfbegin;
module.exports.__pfend = __pfend;
module.exports.__pfdiscard = __pfdiscard;
module.exports.__pflog = __pflog;
module.exports.__pfflush = __pfflush;
module.exports.__pfschema = __pfschema;
module.exports.__pfjson = __pfjson;

module.exports.EVerbosity = EVerbosity;
module.exports.RuntimeConfigurator = RuntimeConfigurator;
module.exports.ConsoleLogger = ConsoleLogger;
module.exports.FileLogger = FileLogger;
module.exports.DataCollector = DataCollector;
module.exports.DataCollectorHttpProxy = DataCollectorHttpProxy;
module.exports.MachineStats = MachineStats;
module.exports.Profiler = Profiler;
module.exports.DataCollectorServer = DataCollectorServer;
module.exports.Debouncer = Debouncer;
//#endregion