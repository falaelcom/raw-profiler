"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const async = require("async");

const EventEmitter = require("events");

const { lpad, hrtimeToNs } = require("./Utility.js");
const { EVerbosity } = require("./EVerbosity.js");
const { RuntimeConfigurator } = require("./RuntimeConfigurator.js");
const { RemoteRuntimeConfigurator } = require("./RemoteRuntimeConfigurator.js");
const { InternalStats } = require("./InternalStats.js");

const SYNC_FS_WRITES = true;

//	Class: Maintains and flushes to the configured logger multiple profiling/logging data queues. Formats the incoming data for logging.
//	Runtime configuration: `DataCollector` is runtime-configuration-enabled and responds to the following runtime configuration property changes:
//		* `"verbosity"` - the amount of detail in the output is determined based on the currently configured level of verbosity
//		* `"logPath"` - 
//		* `"archivePath"` - 
//		* `"maxLogSizeBytes"` - use `0` to disable log archiving
//		* `"maxArchiveSizeBytes"` - use `0` to keep only one archvie file regardless of total archive size
//		* `"logRequestArchivingModulo"` - use `0` to disable log archiving
//	Events: `DataCollector` emits the following events:
//		* `"info"`, arguments: `message`
//		* `"error"`, arguments: `ncode, message, ex`
//		* `"configurationChanged"`, arguments: `key, value, oldValue, source, ctimes`
//	Remarks:
//		`FileLogger` supports automatic log archiving. To enable, set `maxLogSizeBytes > 0` and `logRequestArchivingModulo > 0`.
//		If the automatic log archiving is enabled, before writing to the fs, the `FileLogger` checks the total size of all accumulated logs **per source key** and if `maxLogSizeBytes` is exceeded:
//			* the current timestamp (`this.archiveStamper`) is regenerated to redirect further logging to new files
//			* all existing orphaned log files(with unmatching timestamps) are archived and then deleted
//			* all accmulated log files with the current timestamp are also archived and then deleted
//			* if `maxArchiveSizeBytes > 0`, the oldest archive zip files are deleted to ensure that the total archive size does not exceed `maxArchiveSizeBytes`.
//		IMPORTANT: All limits are applied per source key and not globally. For Ex., the total archive size with 4 different source keys woiuld be `4 * maxArchiveSizeBytes`.
//		If multiple archiving operations are been started simultaneously by `logBuckets`, all `logBuckets` calls will wait until all archiving operations have finished before invoking
//			their `callback`s. Given that the default `DataCollector` implementation, which is the sole consumer of `FileLogger.logBuckets`, does not allow for simultaneous `logBuckets` 
//			invokations, this behavior has no significant effect on the profiler's operation.
class FileLogger extends EventEmitter
{
	//	Parameter: ```
	//		par:
	//		{
	//			runtimeConfigurator: RuntimeConfigurator,
	//			runtimeInitial:
	//			{
	//				verbosity: string,
	//				logPath: string,
	//				archivePath: string,
	//				maxLogSizeBytes: uint,
	//				maxArchiveSizeBytes: uint,
	//				logRequestArchivingModulo: uint,
	//			},
	//			sourceKey: string,
	//		}
	//	```
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.runtimeConfigurator) throw new Error(`Argument is null: "par.runtimeConfigurator".`);
		if (!(par.runtimeConfigurator instanceof RuntimeConfigurator) && !(par.runtimeConfigurator instanceof RemoteRuntimeConfigurator)) throw new TypeError(`Type mismatch: "par.runtimeConfigurator".`);
		if (!par.runtimeInitial) throw new Error(`Argument is null: "par.runtimeInitial".`);
		if (!par.runtimeInitial.verbosity) throw new Error(`Argument is null: "par.runtimeInitial.verbosity".`);
		if (par.runtimeInitial.logPath !== "" && !par.runtimeInitial.logPath) throw new Error(`Argument is null: "par.runtimeInitial.logPath".`); 
		if (par.runtimeInitial.archivePath !== "" && !par.runtimeInitial.archivePath) throw new Error(`Argument is null: "par.runtimeInitial.archivePath".`); 
		if (isNaN(par.runtimeInitial.maxLogSizeBytes) || par.runtimeInitial.maxLogSizeBytes < 0) throw new Error(`Argument is invalid: "par.runtimeInitial.maxLogSizeBytes".`);
		if (isNaN(par.runtimeInitial.maxArchiveSizeBytes) || par.runtimeInitial.maxArchiveSizeBytes < 0) throw new Error(`Argument is invalid: "par.runtimeInitial.maxArchiveSizeBytes".`);
		if (isNaN(par.runtimeInitial.logRequestArchivingModulo) || par.runtimeInitial.logRequestArchivingModulo < 0) throw new Error(`Argument is invalid: "par.runtimeInitial.logRequestArchivingModulo".`);
		if (par.sourceKey !== "" && !par.sourceKey) throw new Error(`Argument is null: "par.sourceKey".`); 

		this.runtimeConfigurator = par.runtimeConfigurator;
		this.runtimeConfigurator.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.runtimeInitial = par.runtimeInitial;
		this.sourceKey = par.sourceKey;
		
		this.verbosity = this.runtimeInitial.verbosity;
		this.logPath = this.runtimeInitial.logPath;
		this.archivePath = this.runtimeInitial.archivePath;
		this.maxLogSizeBytes = this.runtimeInitial.maxLogSizeBytes;
		this.maxArchiveSizeBytes = this.runtimeInitial.maxArchiveSizeBytes;
		this.logRequestArchivingModulo = this.runtimeInitial.logRequestArchivingModulo;

		this.archiveStamper = lpad(new Date().getTime(), 14, '0');
		this.archivingInProgressCount = 0;

		this.logRequestCounter = 0;
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Parameter: `source: string` - indicates the source for the update of ths setting (see `RuntimeConfigurator.onChanged`, `RemoteRuntimeConfigurator.onChanged`).
	// Parameter: `ctimes: { commandFile: uint | null, configurationFile: uint | null } - `null` times mean the corresponding file could not be accessed for whatever reason; not set with `source === "prop"`.
	onConfigurationChanged(key, value, oldValue, source, ctimes)
	{
		this.emit("configurationChanged", key, value, oldValue, source, ctimes);
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

	//	Function: `logBuckets(currentBucketKey: string, verbosityOverride: EVerbosity | null | void 0, buckets: object, callback: function): void` - logs to the corresponding file the data from the bucket specified by `currentBucketKey` at the
	//		currently configured level of vebosity; performs log collection maintenance tasks.
	//	Parameter: `currentBucketKey: string` - required; the key of the profiling bucket to print.
	//	Parameter: `verbosityOverride: EVerbosity | null` - required; if set to `null`, `this.verbosity` setting will be used.
	//	Parameter: `buckets: object` - required; a bucket dictionary as returned by `DataCollector.formatStats`.
	//	Parameter: `callback: function` - required; a callback to invoke after the logging completes.
	//	Remarks: Performs the following log collection maintenance tasks:
	//		- log file archiving - when certain conditions are met, the currently accumulated logs are compressed and moved to an archive directory;
	//		- log file archive triming - when certain conditions are met, the oldest of the currently accumulated log archive files are deleted.
	logBuckets(currentBucketKey, verbosityOverride, buckets, callback)
	{
		if (!currentBucketKey) throw new Error(`Argument is null: "currentBucketKey".`);
		if (!buckets) throw new Error(`Argument is null: "buckets".`);
		if (!callback) throw new Error(`Argument is null: "callback".`);

		try
		{
			const logFullPath = this.logFullPath;
			const headerBucket = buckets["header"];
			if (!headerBucket)
			{
				throw new Error("ASSERTION FAILED: headerBucket");
			}
			const currentBucket = buckets[currentBucketKey];	//	can be undefined with log lines (`__pflog`)

			const snapshotFileName = currentBucketKey + ".now";
			const snapshotFilePath = path.join(logFullPath, snapshotFileName);

			const prefix = this.maxLogSizeBytes ? this.archiveStamper + "-" : "";
			const logFileName = prefix + currentBucketKey + ".log";
			const logFilePath = path.join(logFullPath, logFileName);

			return async.series(
			[
				function (next)
				{
					return fs.access(logFullPath, function (err, result)
					{
						if (err)
						{
							this.onInfo(`Creating log directory "${logFullPath}".`);
							return fs.mkdir(logFullPath, { recursive: true }, next);
						}
						return next();
					}.bind(this));
				}.bind(this),
				function (next)
				{
					if (currentBucket && headerBucket[EVerbosity.Full]) return __writeFileDiag(SYNC_FS_WRITES, snapshotFilePath, headerBucket[EVerbosity.Full], next);
					else return next();
				},
				function (next)
				{
					if (currentBucket && currentBucket[EVerbosity.Full]) return __appendFileDiag(SYNC_FS_WRITES, snapshotFilePath, "\n" + currentBucket[EVerbosity.Full], next);
					else return next();
				},
				function (next)
				{
					if (headerBucket[verbosityOverride || this.verbosity]) return __appendFileDiag(SYNC_FS_WRITES, logFilePath, "\n" + headerBucket[verbosityOverride || this.verbosity], next);
					else return next();
				}.bind(this),
				function (next)
				{
					if (currentBucket && currentBucket[verbosityOverride || this.verbosity]) return __appendFileDiag(SYNC_FS_WRITES, logFilePath, "\n" + currentBucket[verbosityOverride || this.verbosity], next);
					else return next();
				}.bind(this),
				function (next)
				{
					if (this.logRequestCounter % this.logRequestArchivingModulo == 0)
					{
						return this._tryArchiveLogFiles(next);
					}
					else return next();
				}.bind(this),
				function (next)
				{
					++this.logRequestCounter;
					return next();
				}.bind(this)
			], callback);
		}
		catch (ex)
		{
			return callback(ex);
		}
	}

	//	Function: `	getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `fileLogger`
	//	{
	//		{ setting: "fileLogger.sourceKey", type: "preconf", value: "node1" },
	//		{ setting: "fileLogger.verbosity", type: "runtime", value: "full" },
	//		{ setting: "fileLogger.logPath", type: "runtime", value: "/var/__pflogs" },
	//		{ setting: "fileLogger.archivePath", type: "runtime", value: "/var/__pfarchive" },
	//		{ setting: "fileLogger.maxLogSizeBytes", type: "runtime", value: 0, explanation: "auto-archiving DISABLED" },
	//		{ setting: "fileLogger.maxArchiveSizeBytes", type: "runtime", value: 0, explanation: "archive trimming DISABLED" },
	//		{ setting: "fileLogger.logRequestArchivingModulo", type: "runtime", value: 0, explanation: "auto-archiving DISABLED" },
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];
		result.push({ setting: fp + "sourceKey", type: "preconf", value: this.sourceKey });

		result.push({ setting: fp + "verbosity", type: "runtime", value: this.verbosity });
		result.push({ setting: fp + "logPath", type: "runtime", value: this.logFullPath });
		result.push({ setting: fp + "archivePath", type: "runtime", value: this.archiveFullPath });
		result.push({ setting: fp + "maxLogSizeBytes", type: "runtime", value: this.maxLogSizeBytes, explanation: (this.maxLogSizeBytes && this.logRequestArchivingModulo) ? "auto-archiving ENABLED" : "auto-archiving DISABLED" });
		result.push({ setting: fp + "maxArchiveSizeBytes", type: "runtime", value: this.maxArchiveSizeBytes, explanation: (this.maxLogSizeBytes && this.logRequestArchivingModulo && this.maxArchiveSizeBytes) ? "auto-archiving ENABLED" : "archive trimming DISABLED" });
		result.push({ setting: fp + "logRequestArchivingModulo", type: "runtime", value: this.logRequestArchivingModulo, explanation: (this.maxLogSizeBytes && this.logRequestArchivingModulo) ? "auto-archiving ENABLED" : "auto-archiving DISABLED" });

		return result;
	}

	//	Function: Handles runtime configuration changes.
	async runtimeConfiguration_changed(key, value, oldValue, source, ctimes)
	{
		switch (key)
		{
			case "logger.verbosity":
				this.verbosity = (value === EVerbosity.Full || value === EVerbosity.Brief || value === EVerbosity.Full) ? value : this.runtimeInitial.verbosity;
				this.onConfigurationChanged(key, this.verbosity, oldValue, source, ctimes);
				return;
			case "logger.logPath":
			{
				const currentLogFullPath = __resolvePath("~/", path.join(this.logPath, this.sourceKey));
				const value2 = (value === void 0 || value === null) ? this.runtimeInitial.logPath : value;
				const logFullPath = __resolvePath("~/", path.join(value2, this.sourceKey));
				if (logFullPath === currentLogFullPath) return;
				try
				{
					await fs.promises.access(logFullPath);
				}
				catch (ex)
				{
					this.onInfo(`Creating log directory "${logFullPath}".`);
					try
					{
						await fs.promises.mkdir(logFullPath, { recursive: true });
					}
					catch (ex2)
					{
						this.onError(2462891, `Cannot use log path "${logFullPath}", will keep using the old setting "${currentLogFullPath}"`, ex2);
						return;
					}
				}
				this.logPath = value2;
				this.onConfigurationChanged(key, this.logPath, oldValue, source, ctimes);
				break;
			}
			case "logger.archivePath":
			{
				const currentArchiveFullPath = __resolvePath("~/", this.archivePath);
				const value2 = (value === void 0 || value === null) ? this.runtimeInitial.archivePath : value;
				const archiveFullPath = __resolvePath("~/", value2);
				if (archiveFullPath === currentArchiveFullPath) return;
				try
				{
					await fs.promises.access(archiveFullPath);
				}
				catch (ex)
				{
					this.onInfo(`Creating log archive directory "${archiveFullPath}".`);
					try
					{
						await fs.promises.mkdir(archiveFullPath, { recursive: true });
					}
					catch (ex2)
					{
						this.onError(246281, `Cannot use archive log path "${archiveFullPath}", will keep using the old setting "${currentArchiveFullPath}"`, ex2);
						return;
					}
				}
				this.archivePath = value2;
				this.onConfigurationChanged(key, this.archivePath, oldValue, source, ctimes);
				break;
			}
			case "logger.maxLogSizeBytes":
				this.maxLogSizeBytes = isNaN(value) || value < 0 ? this.runtimeInitial.maxLogSizeBytes : value;
				this.onConfigurationChanged(key, this.maxLogSizeBytes, oldValue, source, ctimes);
				return;
			case "logger.maxArchiveSizeBytes":
				this.maxArchiveSizeBytes = isNaN(value) || value < 0 ? this.runtimeInitial.maxArchiveSizeBytes : value;
				this.onConfigurationChanged(key, this.maxArchiveSizeBytes, oldValue, source, ctimes);
				return;
			case "logger.logRequestArchivingModulo":
				this.logRequestArchivingModulo = isNaN(value) || value < 0 || value > 100 ? this.runtimeInitial.logRequestArchivingModulo : value;
				this.onConfigurationChanged(key, this.logRequestArchivingModulo, oldValue, source, ctimes);
				return;
		}
	}

	_listOrphanedLogFiles(callback)
	{
		try
		{
			const result = [];

			if (!this.maxLogSizeBytes)
			{
				return callback(null, result);
			}

			const logFullPath = this.logFullPath;
			const prefix = this.archiveStamper + "-";

			return async.waterfall(
			[
				function (next)
				{
					return fs.readdir(logFullPath, next);
				},
				function (entries, next)
				{
					return async.eachSeries(entries, function (item, itemNext)
					{
						const fullPath = path.join(logFullPath, item);
						return fs.stat(fullPath, function (err, stats)
						{
							if (stats.isDirectory())
							{
								return itemNext();
							}
							if (item.indexOf(prefix) != -1)
							{
								return itemNext();
							}
							if (path.extname(item) != ".log")
							{
								return itemNext();
							}
							result.push(fullPath);
							return itemNext();
						});
					}, next);
				}
			], function (err)
			{
				return callback(err, result);
			});
		}
		catch (ex)
		{
			return callback(new Error(ex));
		}
	}

	_getCurrentLogFilesInfo(callback)
	{
		try
		{
			const result =
			{
				logFiles: [],
				totalLogSize: 0,
			};

			if (!this.maxLogSizeBytes)
			{
				return callback(result);
			}

			const logFullPath = this.logFullPath;
			const prefix = this.archiveStamper + "-";

			return async.waterfall(
			[
				function (next)
				{
					return fs.readdir(logFullPath, next);
				},
				function (entries, next)
				{
					return async.eachSeries(entries, function (item, itemNext)
					{
						const fullPath = path.join(logFullPath, item);
						return fs.stat(fullPath, function (err, stats)
						{
							if (stats.isDirectory())
							{
								return itemNext();
							}
							const extension = path.extname(item);
							if (extension != ".log" && extension != ".now")
							{
								return itemNext();
							}
							if (extension == ".log" && item.indexOf(prefix) == -1)
							{
								return itemNext();
							}
							result.logFiles.push(fullPath);
							result.totalLogSize += stats.size;
							return itemNext();
						});
					}, next);
				}
			], function (err)
			{
				return callback(err, result);
			});
		}
		catch (ex)
		{
			return callback(new Error(ex));
		}
	}

	_getArchiveFilesInfo(archiveDirectory, callback)
	{
		try
		{
			const result =
			{
				archiveFiles: [],
				totalArchiveSize: 0,
			};

			if (!this.maxLogSizeBytes)
			{
				return callback(null, result);
			}

			return async.waterfall(
			[
				function (next)
				{
					return fs.readdir(archiveDirectory, next);
				},
				function (entries, next)
				{
					return async.eachSeries(entries, function (item, itemNext)
					{
						const fullPath = path.join(archiveDirectory, item);
						return fs.stat(fullPath, function (err, stats)
						{
							if (err)
							{
								this.onError(9347865, `Cannot stat ${JSON.stringify(fullPath)}.`, err);
								return itemNext();
							}
							if (stats.isDirectory())
							{
								return itemNext();
							}
							const extension = path.extname(item);
							if (extension != ".zip")
							{
								return itemNext();
							}
							result.archiveFiles.push(
							{
								fullPath: fullPath,
								size: stats.size,
								mtime: stats.mtime,
							});
							result.totalArchiveSize += stats.size;
							return itemNext();
						});
					}, next);
				}.bind(this)
			], function (err)
			{
				return callback(err, result);
			});
		}
		catch (ex)
		{
			return callback(new Error(ex));
		}
	}

	_archiveLogFiles(logFiles, archiveName, callback)
	{
		const output = fs.createWriteStream(archiveName);
		const archive = archiver("zip");
		archive.on("error", err => this.onError(6346135, "Error creating a profiling log archive", err));

		this.archivingInProgressCount++;
		output.on("close", function ()
		{
			this.onInfo("Deleting old log files... ");
			return async.eachSeries(logFiles, function (item, itemNext)
			{
				if (path.extname(item) == ".now") return itemNext();
				return fs.unlink(item, err =>
				{
					if (err) this.onError(28376423, `Error deleting old profiling log file ${JSON.stringify(item)}`, err);
					return itemNext();
				});
			}, () =>
			{
				this.archivingInProgressCount--;
				if (!this.archivingInProgressCount)
				{
					return callback();
				}
			});
		}.bind(this));

		archive.pipe(output);

		for (let length = logFiles.length, i = 0; i < length; ++i)
		{
			const item = logFiles[i];
			try
			{
				archive.append(fs.createReadStream(item), { name: path.basename(item) });
			}
			catch (ex)
			{
				this.onError(83647223, `Error appending profiling log file ${JSON.stringify(logFiles[i])} to archive`, ex);
			}
		}

		archive.finalize();
	}

	_tryArchiveLogFiles(callback)
	{
		try
		{
			if (!this.maxLogSizeBytes)
			{
				return callback();
			}

			if (this.archivingInProgressCount)
			{
				return callback();
			}

			//  no callback is intentional - we don't care when archiving ends
			const archivingFinishedCallback = (archiveDirectory) =>
			{
				return async.waterfall(
				[
					function (next)
					{
						return this._getArchiveFilesInfo(archiveDirectory, next);
					}.bind(this),
					function (archiveFilesInfo, next)
					{
						if (archiveFilesInfo.totalArchiveSize >= this.maxArchiveSizeBytes)
						{
							this.onInfo("Total archive size is now " + (Math.round(100 * archiveFilesInfo.totalArchiveSize / (1024 * 1024)) / 100) + "Mb and exceeds the maximun archive size setting: " + (Math.round(100 * this.maxArchiveSizeBytes / (1024 * 1024)) / 100) + "Mb");
							this.onInfo("Deleting oldest archive files...");
							
							archiveFilesInfo.archiveFiles.sort(function (left, right)
							{
								return left.mtime.getTime() - right.mtime.getTime();
							});

							const delta = archiveFilesInfo.totalArchiveSize - this.maxArchiveSizeBytes;
							let cumulativeSize = 0;
							const filesToRemove = [];
							for (let length = archiveFilesInfo.archiveFiles.length, i = 0; i < length; ++i)
							{
								const item = archiveFilesInfo.archiveFiles[i];
								cumulativeSize += item.size;
								if (cumulativeSize >= delta)
								{
									break;
								}
								filesToRemove.push(item.fullPath);
							}

							return async.each(filesToRemove, (item, itemNext) =>
							{
								try
								{
									return fs.unlink(item, itemNext);
								}
								catch (ex)
								{
									this.onError(283764423, `Error deleting old archive file ${JSON.stringify(item)}.`, ex);
									return itemNext();
								}
							}, next);
						}

						this.onInfo("Done.");
					}.bind(this),
				], function (err)
				{
					if(err) this.onError(28376423, `Unexpected error during log files archiving.`, err);
				}.bind(this));
			};

			this.archivingInProgressCount++;
			let archiveDirectory = path.join(this.archiveFullPath, this.sourceKey);
			return async.waterfall(
			[
				function (next)
				{
					return fs.access(archiveDirectory, err =>
					{
						if (err)
						{
							this.onInfo(`Creating log archive directory "${archiveDirectory}".`);
							return fs.mkdir(archiveDirectory, { recursive: true }, function (err)
							{
								if (!err) return next(null, archiveDirectory);
								this.onError(85647228, `Cannot access the configured archive path ${JSON.stringify(archiveDirectory)}, will use the default archive directory ${JSON.stringify(this.logFullPath)}.`, ex);
								return next(null, this.logFullPath);
							});
						}
						return next(null, archiveDirectory);
					});
				}.bind(this),
				function (result, next)
				{
					archiveDirectory = result;
					return this._listOrphanedLogFiles(next);
				}.bind(this),
				function (orphanedLogList, next)
				{
					if (orphanedLogList.length)
					{
						const orphanedStamper = lpad(new Date().getTime(), 14, '0');
						const orphanedArchiveName = path.join(archiveDirectory, orphanedStamper + "-orphaned.zip");

						this.onInfo("Archiving orphaned files to \"" + orphanedArchiveName + "\"...");

						//  intentionally forking the waterfall, there is no need to wait for the zip-process to finish
						this._archiveLogFiles(orphanedLogList, orphanedArchiveName, () => archivingFinishedCallback(archiveDirectory));
					}
					return next();
				}.bind(this),
				function (next)
				{
					return this._getCurrentLogFilesInfo(next);
				}.bind(this),
				function (currentLogInfo, next)
				{
					if (currentLogInfo.totalLogSize >= this.maxLogSizeBytes)
					{
						const archiveName = path.join(archiveDirectory, this.archiveStamper + ".zip");

						this.onInfo("Archiving a total of " + (Math.round(100 * currentLogInfo.totalLogSize / (1024 * 1024)) / 100) + "Mb of log files to \"" + archiveName + "\"...");

						//  from this point on the code will become asynchroneous, so we change the this.archiveStamper in order to redirect new logs to new files,
						//  while the old log files are being compressed, archived and eventually deleted
						this.archiveStamper = lpad(new Date().getTime(), 14, '0');

						//  intentionally forking the waterfall, there is no need to wait for the zip-process to finish
						this._archiveLogFiles(currentLogInfo.logFiles, archiveName, () => archivingFinishedCallback(archiveDirectory));
					}
					return next();
				}.bind(this)
			], function (err)
			{
				this.archivingInProgressCount--;
				return callback(err);
			}.bind(this));
		}
		catch (ex)
		{
			return callback(new Error(ex));
		}
	}

	get isArchiving()
	{
		return this.archivingInProgressCount !== 0;
	}

	get logFullPath()
	{
		return __resolvePath("~/", path.join(this.logPath, this.sourceKey));
	}

	get archiveFullPath()
	{
		return __resolvePath("~/", this.archivePath);
	}
}

function __resolvePath(base, target)
{
	return path.resolve(base.replace('~', os.homedir()), target);
}

function __writeFileDiag(syncFsWrite, path, text, callback)
{
	//	profiler self-profiling
	const start_hrtime = process.hrtime();
	//	/profiler self-profiling

	if (!syncFsWrite) return fs.writeFile(path, text, err =>
	{
		//	profiler self-profiling
		const duration_hrtime = process.hrtime(start_hrtime);
		const durationNs = hrtimeToNs(duration_hrtime);
		InternalStats.fsWriteTotalNs += durationNs;
		++InternalStats.fsWriteCount;
		InternalStats.fsWriteAvgNs = InternalStats.fsWriteAvgNs + (durationNs - InternalStats.fsWriteAvgNs) / InternalStats.fsWriteCount;
		//	/profiler self-profiling

		return callback(err);
	});
	try
	{
		fs.writeFileSync(path, text);
		return callback(null);
	}
	catch (ex)
	{
		return callback(ex);
	}
	finally
	{
		//	profiler self-profiling
		const duration_hrtime = process.hrtime(start_hrtime);
		const durationNs = hrtimeToNs(duration_hrtime);
		InternalStats.fsWriteTotalNs += durationNs;
		++InternalStats.fsWriteCount;
		InternalStats.fsWriteAvgNs = InternalStats.fsWriteAvgNs + (durationNs - InternalStats.fsWriteAvgNs) / InternalStats.fsWriteCount;
		//	/profiler self-profiling
	}
}

function __appendFileDiag(syncFsWrite, path, text, callback)
{
	//	profiler self-profiling
	const start_hrtime = process.hrtime();
	//	/profiler self-profiling

	if (!syncFsWrite) return fs.appendFile(path, text, err =>
	{
		//	profiler self-profiling
		const duration_hrtime = process.hrtime(start_hrtime);
		const durationNs = hrtimeToNs(duration_hrtime);
		InternalStats.fsWriteTotalNs += durationNs;
		++InternalStats.fsWriteCount;
		InternalStats.fsWriteAvgNs = InternalStats.fsWriteAvgNs + (durationNs - InternalStats.fsWriteAvgNs) / InternalStats.fsWriteCount;
		//	/profiler self-profiling

		return callback(err);
	});
	try
	{
		fs.appendFileSync(path, text);
		return callback(null);
	}
	catch (ex)
	{
		return callback(ex);
	}
	finally
	{
		//	profiler self-profiling
		const duration_hrtime = process.hrtime(start_hrtime);
		const durationNs = hrtimeToNs(duration_hrtime);
		InternalStats.fsWriteTotalNs += durationNs;
		++InternalStats.fsWriteCount;
		InternalStats.fsWriteAvgNs = InternalStats.fsWriteAvgNs + (durationNs - InternalStats.fsWriteAvgNs) / InternalStats.fsWriteCount;
		//	/profiler self-profiling
	}
}

module.exports = FileLogger;
module.exports.FileLogger = module.exports;
