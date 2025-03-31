import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { promisify } from 'util';

const exec = promisify(cp.exec);
const exists = promisify(fs.exists);

// Output channel for logging
const outputChannel = vscode.window.createOutputChannel('Android Emulator');

export function activate(context: vscode.ExtensionContext) {
  // Register the sidebar webview provider
  const provider = new AndroidEmulatorViewProvider(context.extensionUri);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('androidEmulatorView', provider)
  );

  // Command for opening the sidebar
  let disposable = vscode.commands.registerCommand('vscode-android-emulator-sidepanel.openEmulator', () => {
    vscode.commands.executeCommand('workbench.view.extension.android-emulator');
  });

  // Command to open settings
  let openSettingsCmd = vscode.commands.registerCommand('vscode-android-emulator-sidepanel.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-android-emulator-sidepanel');
  });

  // Command to open the output channel
  let openLogsCmd = vscode.commands.registerCommand('vscode-android-emulator-sidepanel.openLogs', () => {
    outputChannel.show();
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(openSettingsCmd);
  context.subscriptions.push(openLogsCmd);
  context.subscriptions.push(outputChannel);

  log('Android Emulator extension activated');
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// Expand environment variables in a path string (like %LOCALAPPDATA% on Windows)
function expandEnvVars(pathWithEnvVars: string): string {
  if (!pathWithEnvVars) {
    return pathWithEnvVars;
  }
  
  // Handle Windows-style %ENVVAR% 
  const windowsRegex = /%([^%]+)%/g;
  let result = pathWithEnvVars.replace(windowsRegex, (_, envName) => {
    return process.env[envName] || '';
  });
  
  // Handle Unix-style $ENVVAR or ${ENVVAR}
  const unixRegex = /\$(?:{([^}]+)}|([a-zA-Z0-9_]+))/g;
  result = result.replace(unixRegex, (_, bracedName, simpleName) => {
    const name = bracedName || simpleName;
    return process.env[name] || '';
  });
  
  // Also handle ~ for home directory
  if (result.startsWith('~')) {
    result = path.join(os.homedir(), result.substring(1));
  }
  
  return result;
}

interface AvdInfo {
  name: string;
  status: 'stopped' | 'running';
}

interface AndroidToolPaths {
  emulator: string;
  adb: string;
  avdHome?: string;
}

class AndroidEmulatorViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getWebviewContent();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'getAvds':
          const avdResult = await this._getAvailableAvds();
          webviewView.webview.postMessage({ 
            command: 'avdList', 
            avds: avdResult.avds,
            error: avdResult.error 
          });
          break;
        case 'launchAvd':
          this._launchAvd(message.avdName);
          break;
        case 'refresh':
          const refreshedResult = await this._getAvailableAvds();
          webviewView.webview.postMessage({ 
            command: 'avdList', 
            avds: refreshedResult.avds,
            error: refreshedResult.error 
          });
          break;
        case 'openSettings':
          vscode.commands.executeCommand('vscode-android-emulator-sidepanel.openSettings');
          break;
        case 'openLogs':
          vscode.commands.executeCommand('vscode-android-emulator-sidepanel.openLogs');
          break;
        case 'detectSdk':
          const detectedPaths = await this._autoDetectSdkPaths();
          webviewView.webview.postMessage({ 
            command: 'sdkDetectionResult',
            paths: detectedPaths
          });
          break;
      }
    });
  }

  private async _autoDetectSdkPaths(): Promise<{ sdkPath?: string, success: boolean }> {
    log('Attempting to auto-detect Android SDK location...');
    
    const possibleLocations: string[] = [];
    const platform = os.platform();
    
    // Common locations based on platform
    if (platform === 'win32') {
      // Windows specific locations
      possibleLocations.push(
        '%LOCALAPPDATA%\\Android\\Sdk',
        '%ANDROID_HOME%',
        '%ANDROID_SDK_ROOT%',
        'C:\\Android\\Sdk'
      );
      
      // Try to find Android Studio installation
      try {
        // Check Program Files locations
        const programFilesDir = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86Dir = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        
        // Common Android Studio paths
        const androidStudioPaths = [
          path.join(programFilesDir, 'Android', 'Android Studio'),
          path.join(programFilesX86Dir, 'Android', 'Android Studio'),
          path.join(programFilesDir, 'Android Studio'),
          path.join(programFilesX86Dir, 'Android Studio')
        ];
        
        // Also check registry keys for Android Studio
        try {
          const { stdout: regOutput } = await exec('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Android Studio" /v Path');
          if (regOutput) {
            const match = regOutput.match(/Path\s+REG_SZ\s+(.+)/);
            if (match && match[1]) {
              androidStudioPaths.push(match[1].trim());
            }
          }
        } catch (e) {
          // Registry key not found - that's ok
        }
        
        // Look for Android SDK installed with Android Studio
        for (const studioPath of androidStudioPaths) {
          if (await exists(studioPath)) {
            log(`Found Android Studio at: ${studioPath}`);
            
            // Android SDK might be in a few places relative to Android Studio
            const possibleSdkPaths = [
              path.join(studioPath, 'Sdk'),
              path.join(path.dirname(studioPath), 'Sdk'),
              path.join(path.dirname(path.dirname(studioPath)), 'Sdk')
            ];
            
            possibleLocations.push(...possibleSdkPaths);
          }
        }
      } catch (e) {
        log(`Error detecting Android Studio: ${e}`);
      }
      
      // Add paths under the user's .android directory
      const userHomeDir = os.homedir();
      possibleLocations.push(
        path.join(userHomeDir, '.android', 'sdk'),
        path.join(userHomeDir, 'AppData', 'Local', 'Android', 'sdk')
      );
    } else if (platform === 'darwin') {
      possibleLocations.push(
        '~/Library/Android/sdk',
        '$ANDROID_HOME',
        '$ANDROID_SDK_ROOT'
      );
    } else {
      // Linux
      possibleLocations.push(
        '~/Android/Sdk',
        '$ANDROID_HOME',
        '$ANDROID_SDK_ROOT',
        '/opt/android-sdk'
      );
    }
    
    // First, check ANDROID_HOME and ANDROID_SDK_ROOT environment variables
    const androidHome = process.env.ANDROID_HOME;
    const androidSdkRoot = process.env.ANDROID_SDK_ROOT;
    
    if (androidHome && await exists(androidHome)) {
      log(`Found SDK via ANDROID_HOME: ${androidHome}`);
      return await this._configureSdkPath(androidHome);
    }
    
    if (androidSdkRoot && await exists(androidSdkRoot)) {
      log(`Found SDK via ANDROID_SDK_ROOT: ${androidSdkRoot}`);
      return await this._configureSdkPath(androidSdkRoot);
    }
    
    // Check each location
    for (const loc of possibleLocations) {
      const expandedPath = expandEnvVars(loc);
      log(`Checking potential SDK path: ${expandedPath}`);
      
      try {
        if (await exists(expandedPath)) {
          // Check if this is a valid SDK directory
          if (await this._isValidSdkLocation(expandedPath)) {
            log(`SDK detected at: ${expandedPath}`);
            return await this._configureSdkPath(expandedPath);
          }
        }
      } catch (error) {
        log(`Error checking path ${expandedPath}: ${error}`);
      }
    }
    
    // If we found the .android/avd directory but not the SDK, try finding Android Studio
    const homeDir = os.homedir();
    const avdHomeDir = path.join(homeDir, '.android', 'avd');
    
    if (await exists(avdHomeDir)) {
      log('Found .android/avd directory. Searching for Android Studio installation...');
      
      // If on Windows, add an additional check for Android Studio in the default installation path
      if (platform === 'win32') {
        const androidAppData = path.join(homeDir, 'AppData', 'Local', 'Android');
        if (await exists(androidAppData)) {
          const possibleSdkDir = path.join(androidAppData, 'Sdk');
          if (await exists(possibleSdkDir)) {
            if (await this._isValidSdkLocation(possibleSdkDir)) {
              log(`Found SDK in default Windows location: ${possibleSdkDir}`);
              return await this._configureSdkPath(possibleSdkDir);
            }
          }
        }
      }
    }
    
    log('Could not automatically detect Android SDK location');
    return { success: false };
  }

  private async _isValidSdkLocation(sdkPath: string): Promise<boolean> {
    // Check for key folders that should exist in an SDK
    const platformToolsPath = path.join(sdkPath, 'platform-tools');
    const platform = os.platform();
    const adbPath = path.join(platformToolsPath, platform === 'win32' ? 'adb.exe' : 'adb');
    
    // Look for either platform-tools/adb or tools folder
    const hasAdb = await exists(adbPath);
    const hasToolsDir = await exists(path.join(sdkPath, 'tools'));
    const hasPlatformToolsDir = await exists(platformToolsPath);
    const hasEmulatorDir = await exists(path.join(sdkPath, 'emulator'));
    
    const isValid = hasAdb || (hasPlatformToolsDir && (hasToolsDir || hasEmulatorDir));
    
    if (isValid) {
      log(`Valid SDK found at: ${sdkPath}`);
    } else {
      log(`Invalid SDK structure at: ${sdkPath}`);
    }
    
    return isValid;
  }
  
  private async _configureSdkPath(sdkPath: string): Promise<{ sdkPath: string, success: boolean }> {
    try {
      // Update settings
      const config = vscode.workspace.getConfiguration('vscode-android-emulator-sidepanel');
      await config.update('sdkPath', sdkPath, vscode.ConfigurationTarget.Global);
      
      return { sdkPath, success: true };
    } catch (error) {
      log(`Error updating SDK path: ${error}`);
      return { sdkPath, success: false };
    }
  }

  private async _findAndroidTools(): Promise<{ paths: AndroidToolPaths, error?: string }> {
    const config = vscode.workspace.getConfiguration('vscode-android-emulator-sidepanel');
    let sdkPath = config.get('sdkPath', '');
    const emulatorPathConfig = config.get('emulatorPath', '');
    const adbPathConfig = config.get('adbPath', '');
    
    // Expand environment variables in configured paths
    sdkPath = expandEnvVars(sdkPath);
    const configuredEmulatorPath = expandEnvVars(emulatorPathConfig);
    const configuredAdbPath = expandEnvVars(adbPathConfig);
    
    let emulatorPath = '';
    let adbPath = '';
    let avdHome = '';
    let error = '';
    
    log(`Looking for Android tools with: SDK=${sdkPath}, Emulator=${configuredEmulatorPath}, ADB=${configuredAdbPath}`);

    // Try to find AVD home directory
    const homeDir = os.homedir();
    const avdHomeCandidate = path.join(homeDir, '.android', 'avd');
    if (await exists(avdHomeCandidate)) {
      avdHome = avdHomeCandidate;
      log(`Found AVD home directory: ${avdHome}`);
    }

    // If paths are directly configured, use them
    if (configuredEmulatorPath) {
      emulatorPath = configuredEmulatorPath;
      if (!await exists(emulatorPath)) {
        error = `Configured emulator path does not exist: ${emulatorPath}`;
        log(error);
      } else {
        log(`Using configured emulator path: ${emulatorPath}`);
      }
    }

    if (configuredAdbPath) {
      adbPath = configuredAdbPath;
      if (!await exists(adbPath)) {
        error = `${error ? error + '\n' : ''}Configured adb path does not exist: ${adbPath}`;
        log(error);
      } else {
        log(`Using configured adb path: ${adbPath}`);
      }
    }

    // If SDK path is provided but tools weren't directly configured
    if (sdkPath) {
      const platform = os.platform();
      const exeSuffix = platform === 'win32' ? '.exe' : '';

      if (!emulatorPath) {
        // Try to find emulator in the SDK path
        const possibleEmulatorLocations = [
          path.join(sdkPath, 'emulator', `emulator${exeSuffix}`),
          path.join(sdkPath, 'tools', `emulator${exeSuffix}`),
          path.join(sdkPath, 'tools', 'emulator', `emulator${exeSuffix}`),
          path.join(sdkPath, 'tools', 'bin', `emulator${exeSuffix}`)
        ];

        for (const location of possibleEmulatorLocations) {
          log(`Checking for emulator at: ${location}`);
          if (await exists(location)) {
            emulatorPath = location;
            log(`Found emulator at: ${location}`);
            break;
          }
        }
        
        // On Windows, also try without the .exe extension
        if (!emulatorPath && platform === 'win32') {
          const winEmulatorScript = path.join(sdkPath, 'emulator', 'emulator');
          if (await exists(winEmulatorScript)) {
            emulatorPath = winEmulatorScript;
            log(`Found emulator script at: ${winEmulatorScript}`);
          }
        }
      }

      if (!adbPath) {
        // Try to find adb in the SDK path
        const possibleAdbLocations = [
          path.join(sdkPath, 'platform-tools', `adb${exeSuffix}`),
        ];

        for (const location of possibleAdbLocations) {
          log(`Checking for adb at: ${location}`);
          if (await exists(location)) {
            adbPath = location;
            log(`Found adb at: ${location}`);
            break;
          }
        }
      }
    }

    // If we still don't have paths, use command names and let PATH environment handle it
    if (!emulatorPath) {
      emulatorPath = 'emulator';
      log('Using emulator from PATH');
    }
    
    if (!adbPath) {
      adbPath = 'adb';
      log('Using adb from PATH');
    }
    
    // Add a direct error if neither is found and we have AVDs
    if (avdHome && !sdkPath) {
      error = 'Found Android AVDs but the Android SDK path is not configured. Please click "Auto-Detect SDK" or configure the SDK path manually.';
    }

    return { paths: { emulator: emulatorPath, adb: adbPath, avdHome }, error };
  }

  private async _getAvailableAvds(): Promise<{ avds: AvdInfo[], error?: string }> {
    try {
      const { paths, error: toolError } = await this._findAndroidTools();
      
      if (toolError) {
        return { avds: [], error: toolError };
      }

      // Try different methods to get AVDs
      let avdList: string[] = [];
      
      // Method 1: Using emulator -list-avd
      try {
        log(`Executing: ${paths.emulator} -list-avd`);
        const { stdout } = await exec(`"${paths.emulator}" -list-avd`);
        
        if (stdout && stdout.trim()) {
          log(`emulator -list-avd output: ${stdout.replace(/\n/g, ', ')}`);
          avdList = stdout.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        } else {
          log('emulator -list-avd returned empty list');
        }
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        log(`Error executing emulator -list-avd: ${error}`);
        
        // Windows-specific check for missing Android SDK in PATH
        if (os.platform() === 'win32' && errorMsg.includes('is not recognized as an internal or external command')) {
          log('Windows PATH error detected. SDK tools not in PATH.');
        }
      }
      
      // Method 2: If previous method failed or returned empty, try reading AVD folder
      if (avdList.length === 0 && paths.avdHome) {
        try {
          log(`Trying to read AVD files from ${paths.avdHome}`);
          const files = await fs.promises.readdir(paths.avdHome);
          const avdFiles = files.filter(file => file.endsWith('.ini'));
          
          avdList = avdFiles
            .map(file => file.replace('.ini', ''))
            .filter(name => name !== 'config'); // Skip config.ini
          
          log(`Found AVD files: ${avdList.join(', ')}`);
        } catch (error) {
          log(`Error reading AVD home directory: ${error}`);
        }
      }

      // If still no AVDs found, return empty with explanation
      if (avdList.length === 0) {
        log('No AVDs found by any detection method');
        return { avds: [], error: "No Android virtual devices found. Create some using Android Studio." };
      }

      // Convert to AvdInfo objects - all initially set to stopped
      const avds = avdList.map(name => ({ name, status: 'stopped' as 'stopped' | 'running' }));

      log(`Found ${avds.length} AVDs: ${avdList.join(', ')}`);
      
      // Get running emulators with increased timeout for reliability
      log('Getting running emulator information...');
      const runningEmulatorMap = await this._getRunningEmulators(paths.adb);
      
      // Debug information to help diagnose name matching issues
      log('=== DEBUGGING NAME MATCHING ===');
      log(`Available AVDs: ${avds.map(avd => `"${avd.name}"`).join(', ')}`);
      log(`Running AVD map keys: ${Array.from(runningEmulatorMap.keys()).map(name => `"${name}"`).join(', ')}`);
      
      // Create a normalized map for case-insensitive lookup
      const normalizedRunningMap = new Map<string, string>();
      for (const [avdName, emulatorId] of runningEmulatorMap.entries()) {
        normalizedRunningMap.set(this._normalizeAvdName(avdName), emulatorId);
        log(`Normalized running AVD: "${avdName}" -> "${this._normalizeAvdName(avdName)}"`);
      }
      
      // Mark AVDs as running if they are found in the running map
      for (const avd of avds) {
        const normalizedName = this._normalizeAvdName(avd.name);
        log(`Checking if "${avd.name}" (normalized: "${normalizedName}") is running...`);
        
        if (normalizedRunningMap.has(normalizedName)) {
          avd.status = 'running';
          const emulatorId = normalizedRunningMap.get(normalizedName);
          log(`✓ Marked AVD ${avd.name} as running (emulator ID: ${emulatorId})`);
        } else if (runningEmulatorMap.has(avd.name)) {
          // Direct match without normalization as fallback
          avd.status = 'running';
          const emulatorId = runningEmulatorMap.get(avd.name);
          log(`✓ Marked AVD ${avd.name} as running (direct match, emulator ID: ${emulatorId})`);
        } else {
          // Additional check - look for a partial match in case of truncated names
          let found = false;
          for (const [runningName, emulatorId] of runningEmulatorMap.entries()) {
            if (runningName.includes(avd.name) || avd.name.includes(runningName)) {
              avd.status = 'running';
              log(`✓ Marked AVD ${avd.name} as running (partial match with "${runningName}", emulator ID: ${emulatorId})`);
              found = true;
              break;
            }
          }
          
          if (!found) {
            log(`AVD ${avd.name} is not running`);
          }
        }
      }
      log('=== END DEBUGGING ===');
      
      return { avds };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      let detailedError = 'Failed to list Android AVDs. ';
      
      if (errorMsg.includes('not recognized') || errorMsg.includes('command not found')) {
        detailedError += 'Android SDK tools not found in PATH. Please use "Auto-Detect SDK" or configure the SDK path manually in settings.';
      } else {
        detailedError += errorMsg;
      }
      
      log(`Error in _getAvailableAvds: ${detailedError}`);
      return { avds: [], error: detailedError };
    }
  }

  // Helper method to normalize AVD names for consistent comparison
  private _normalizeAvdName(name: string): string {
    // Trim whitespace, convert to lowercase, and remove special characters
    return name.trim().toLowerCase()
      .replace(/[\s_-]+/g, '') // Remove spaces, underscores, hyphens
      .replace(/[^\w\d]/g, ''); // Remove non-alphanumeric characters
  }

  private async _getRunningEmulators(adbPath: string): Promise<Map<string, string>> {
    const runningMap = new Map<string, string>();
    
    try {
      log(`Executing: ${adbPath} devices`);
      const { stdout: devicesOutput } = await exec(`"${adbPath}" devices`);
      log(`adb devices output: ${devicesOutput}`);
      
      // Extract running emulator IDs
      const runningEmulators: string[] = [];
      const deviceLines = devicesOutput.split('\n');
      
      for (const line of deviceLines) {
        const match = line.match(/^(emulator-\d+)\s+device/);
        if (match) {
          const emulatorId = match[1];
          runningEmulators.push(emulatorId);
          log(`Found running emulator: ${emulatorId}`);
        }
      }
      
      if (runningEmulators.length === 0) {
        log('No running emulators found');
        return runningMap;
      }
      
      // For each running emulator, try multiple approaches to identify its AVD name
      for (const emulatorId of runningEmulators) {
        const port = emulatorId.split('-')[1]; // Extract port from emulator-XXXX

        try {
          // Approach 1: Use 'emu avd name' command - most reliable when it works
          try {
            log(`Trying adb -s ${emulatorId} emu avd name`);
            const { stdout } = await exec(`"${adbPath}" -s ${emulatorId} emu avd name`);
            if (stdout && stdout.trim()) {
              const avdName = stdout.trim();
              runningMap.set(avdName, emulatorId);
              log(`✅ Found AVD name via 'emu avd name': ${avdName} (${emulatorId})`);
              continue; // Success - move to next emulator
            }
          } catch (err) {
            log(`'emu avd name' failed: ${err}`);
          }

          // Approach 2: Use getprop - works well on newer emulators
          try {
            log(`Trying adb -s ${emulatorId} shell getprop ro.kernel.qemu.avd_name`);
            const { stdout } = await exec(`"${adbPath}" -s ${emulatorId} shell getprop ro.kernel.qemu.avd_name`);
            if (stdout && stdout.trim()) {
              const avdName = stdout.trim();
              runningMap.set(avdName, emulatorId);
              log(`✅ Found AVD name via getprop: ${avdName} (${emulatorId})`);
              continue; // Success - move to next emulator
            }
          } catch (err) {
            log(`getprop approach failed: ${err}`);
          }

          // Approach 3: Look in the process list for the emulator command line (Windows)
          if (os.platform() === 'win32') {
            try {
              log(`Trying to find emulator process info for port ${port}`);
              const { stdout: tasklistOutput } = await exec('tasklist /FI "IMAGENAME eq emulator.exe" /V');
              log(`Emulator processes: ${tasklistOutput.slice(0, 200)}...`);
              
              // Look for the emulator process corresponding to our port
              const emulatorProcess = tasklistOutput
                .split('\n')
                .find(line => line.includes(`emulator-${port}`) || line.includes(`-avd`));
              
              if (emulatorProcess) {
                // Extract the AVD name from the process command line
                // Usually in format "... -avd AvdName ..."
                const avdMatch = emulatorProcess.match(/-avd\s+(\S+)/);
                if (avdMatch && avdMatch[1]) {
                  const avdName = avdMatch[1].trim();
                  runningMap.set(avdName, emulatorId);
                  log(`✅ Found AVD name from process list: ${avdName} (${emulatorId})`);
                  continue; // Success - move to next emulator
                }
              }
            } catch (err) {
              log(`Process search approach failed: ${err}`);
            }
          }
          
          // Approach 4: Check running processes (Unix-based systems)
          if (os.platform() !== 'win32') {
            try {
              log('Checking running processes for emulator command lines');
              const { stdout: psOutput } = await exec('ps aux | grep -v grep | grep emulator');
              
              // Look for emulator command lines with our port
              const relevantProcesses = psOutput
                .split('\n')
                .filter(line => line.includes(`-port ${port}`) || line.includes(`emulator-${port}`));
              
              for (const process of relevantProcesses) {
                const avdMatch = process.match(/-avd\s+(\S+)/);
                if (avdMatch && avdMatch[1]) {
                  const avdName = avdMatch[1].trim();
                  runningMap.set(avdName, emulatorId);
                  log(`✅ Found AVD name from ps output: ${avdName} (${emulatorId})`);
                  break; // Found it - break the loop
                }
              }
              
              // If we found an AVD, move to next emulator
              if ([...runningMap.keys()].some(name => runningMap.get(name) === emulatorId)) {
                continue;
              }
            } catch (err) {
              log(`Process search approach failed: ${err}`);
            }
          }
          
          // Last resort: Use the emulator console via telnet
          // This is more complex and less reliable, but sometimes works
          try {
            // Skip on platforms without telnet
            if (os.platform() === 'win32' || await this._commandExists('telnet')) {
              log(`Trying telnet to emulator console on port ${port}`);
              
              let telnetCommand;
              if (os.platform() === 'win32') {
                // Windows requires a bit more care with telnet
                telnetCommand = `echo avd name | telnet localhost ${port}`;
              } else {
                telnetCommand = `printf "avd name\\r\\nquit\\r\\n" | telnet localhost ${port}`;
              }
              
              const { stdout: telnetOutput } = await exec(telnetCommand, { timeout: 3000 });
              log(`Telnet output: ${telnetOutput}`);
              
              // Try to extract the AVD name from the telnet response
              const nameMatches = telnetOutput.match(/avd name\s+['"]?([^'"]+?)['"]?(\s|$)/i) || 
                                 telnetOutput.match(/OK\s+['"]?([^'"]+?)['"]?(\s|$)/i);
                                 
              if (nameMatches && nameMatches[1]) {
                const avdName = nameMatches[1].trim();
                if (avdName && avdName !== 'OK') {
                  runningMap.set(avdName, emulatorId);
                  log(`✅ Found AVD name via telnet: ${avdName} (${emulatorId})`);
                  continue; // Success - move to next emulator
                }
              }
            }
          } catch (err) {
            log(`Telnet approach failed: ${err}`);
          }
          
          log(`⚠️ Could not determine AVD name for emulator ${emulatorId}`);
        } catch (error) {
          log(`Error identifying AVD for emulator ${emulatorId}: ${error}`);
        }
      }
    } catch (e) {
      log(`Error getting running emulators: ${e}`);
    }
    
    // Final debug output of all found AVDs
    log(`Found ${runningMap.size} running AVDs:`);
    for (const [avdName, emulatorId] of runningMap.entries()) {
      log(`- ${avdName} (${emulatorId})`);
    }
    
    return runningMap;
  }
  
  // Helper to check if a command exists on the system
  private async _commandExists(command: string): Promise<boolean> {
    try {
      const checkCmd = os.platform() === 'win32' 
        ? `where ${command}` 
        : `which ${command}`;
      
      await exec(checkCmd);
      return true;
    } catch (e) {
      return false;
    }
  }

  private async _launchAvd(avdName: string) {
    try {
      const { paths, error } = await this._findAndroidTools();
      
      if (error) {
        vscode.window.showErrorMessage(`Failed to launch emulator: ${error}`);
        return;
      }
      
      const platform = os.platform();
      
      if (platform === 'win32') {
        // Windows-specific launch method
        const config = vscode.workspace.getConfiguration('vscode-android-emulator-sidepanel');
        const sdkPath = expandEnvVars(config.get('sdkPath', ''));
        
        if (!sdkPath) {
          vscode.window.showErrorMessage('Unable to launch emulator: Android SDK path not configured. Please use "Auto-Detect SDK" or configure the SDK path manually.');
          return;
        }

        log(`Launching Windows emulator for AVD: ${avdName}`);

        // Try direct execution first - this has highest chance of working
        try {
          // Use direct path to emulator.exe
          const emulatorExe = path.join(sdkPath, 'emulator', 'emulator.exe');
          
          log(`Executing emulator directly: "${emulatorExe}" -avd ${avdName}`);
          
          // Use exec to run the command and capture output
          cp.exec(`"${emulatorExe}" -avd "${avdName}"`, {
            windowsHide: false,  // Show the window
          }, (error, stdout, stderr) => {
            if (error) {
              log(`Error launching emulator: ${error.message}`);
              log(`Stderr: ${stderr}`);
              
              // Try fallback method
              this._launchEmulatorFallback(sdkPath, avdName);
            } else {
              log(`Emulator launch initiated: ${avdName}`);
              log(`Stdout: ${stdout}`);
            }
          });
          
          vscode.window.showInformationMessage(`Launching Android emulator: ${avdName}`);
        } catch (execError) {
          log(`Error in primary launch method: ${execError}`);
          // Try fallback method
          this._launchEmulatorFallback(sdkPath, avdName);
        }
      } else if (platform === 'darwin') {
        // macOS
        command = `osascript -e 'tell application "Terminal" to do script "\\"${paths.emulator}\\" -avd ${avdName}"'`;
        
        cp.exec(command, (error) => {
          if (error) {
            const errorMsg = `Failed to launch AVD: ${error.message}`;
            log(errorMsg);
            vscode.window.showErrorMessage(errorMsg);
          } else {
            const successMsg = `Launching Android emulator: ${avdName}`;
            log(successMsg);
            vscode.window.showInformationMessage(successMsg);
          }
        });
      } else {
        // Linux
        command = `x-terminal-emulator -e "\\"${paths.emulator}\\" -avd ${avdName}"`;
        
        cp.exec(command, (error) => {
          if (error) {
            const errorMsg = `Failed to launch AVD: ${error.message}`;
            log(errorMsg);
            vscode.window.showErrorMessage(errorMsg);
          } else {
            const successMsg = `Launching Android emulator: ${avdName}`;
            log(successMsg);
            vscode.window.showInformationMessage(successMsg);
          }
        });
      }
      
    } catch (error: any) {
      const errorMsg = `Failed to launch Android emulator: ${error?.message || String(error)}`;
      log(errorMsg);
      vscode.window.showErrorMessage(errorMsg);
    }
  }
  
  // New helper method for fallback launch on Windows
  private _launchEmulatorFallback(sdkPath: string, avdName: string) {
    log(`Trying fallback launch method for AVD: ${avdName}`);
    
    try {
      const emulatorDir = path.join(sdkPath, 'emulator');
      
      // Method 1: Using start command directly
      const startCommand = `start cmd.exe /c "cd /d "${emulatorDir}" && emulator.exe -avd "${avdName}" -no-boot-anim"`;
      log(`Executing fallback command: ${startCommand}`);
      
      cp.exec(startCommand, (error) => {
        if (error) {
          log(`Fallback method 1 failed: ${error.message}`);
          
          // Method 2: Using spawn with shell
          try {
            log('Trying fallback method 2: spawn with shell');
            const process = cp.spawn('cmd.exe', ['/c', `cd /d "${emulatorDir}" && emulator.exe -avd "${avdName}"`], {
              detached: true,
              stdio: 'ignore',
              shell: true,
              windowsHide: false
            });
            
            process.unref();
            log('Fallback method 2 executed');
          } catch (spawnError) {
            log(`Fallback method 2 failed: ${spawnError}`);
            vscode.window.showErrorMessage(`Failed to launch Android emulator: ${spawnError}`);
          }
        } else {
          log('Fallback method 1 succeeded');
        }
      });
    } catch (error) {
      log(`All fallback methods failed: ${error}`);
      vscode.window.showErrorMessage(`Failed to launch Android emulator after trying all methods: ${error}`);
    }
  }

  private _getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Android Emulator</title>
        <style>
          body { padding: 0; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
          .container { padding: 10px; }
          .avd-item { 
            padding: 8px;
            margin: 4px 0;
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .avd-item .name {
            flex-grow: 1;
            margin-right: 8px;
          }
          .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            border-radius: 2px;
            cursor: pointer;
          }
          .button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }
          .refresh-btn {
            margin-bottom: 10px;
          }
          .status-running {
            color: #4caf50;
            font-size: 0.8em;
          }
          .status-stopped {
            color: #9e9e9e;
            font-size: 0.8em;
          }
          .loading {
            font-style: italic;
            color: var(--vscode-descriptionForeground);
          }
          .error-message {
            color: var(--vscode-errorForeground);
            margin-bottom: 10px; 
            padding: 8px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 2px;
          }
          .setup-guide {
            margin-top: 20px;
            padding: 10px;
            background-color: var(--vscode-editor-infoBackground);
            border-radius: 4px;
          }
          .setup-guide h4 {
            margin-top: 0;
          }
          .setup-guide ul {
            padding-left: 20px;
            margin-bottom: 10px;
          }
          .button-container {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            flex-wrap: wrap;
            gap: 5px;
          }
          .tools-buttons {
            display: flex;
            gap: 5px;
          }
          .success-message {
            color: #4caf50;
            margin-bottom: 10px;
            padding: 8px;
            background-color: rgba(76, 175, 80, 0.1);
            border: 1px solid rgba(76, 175, 80, 0.5);
            border-radius: 2px;
          }
          .troubleshoot-link {
            margin-top: 15px;
            font-size: 0.9em;
          }
          
          .troubleshoot-link a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
          }
          
          .troubleshoot-link a:hover {
            text-decoration: underline;
          }
          
          .button-row {
            display: flex;
            gap: 8px;
            margin-top: 8px;
          }
          .auto-refresh {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            gap: 5px;
          }
          .auto-refresh input {
            margin: 0;
          }
          .auto-refresh label {
            font-size: 0.9em;
          }
        </style>
    </head>
    <body>
        <div class="container">
            <h3>Android Emulator</h3>
            
            <div class="button-container">
              <button class="button refresh-btn" id="refresh-btn">Refresh AVD List</button>
              <div class="tools-buttons">
                <button class="button" id="settings-btn">Configure SDK</button>
                <button class="button" id="detect-sdk-btn">Auto-Detect SDK</button>
                <button class="button" id="logs-btn">View Logs</button>
              </div>
            </div>
            
            <div class="auto-refresh">
              <input type="checkbox" id="auto-refresh-check" checked>
              <label for="auto-refresh-check">Auto-refresh (every 5 seconds)</label>
            </div>
            
            <div id="message-container"></div>
            <div id="error-container"></div>
            <p id="loading-text" class="loading">Loading available AVDs...</p>
            <div id="avd-list"></div>
            
            <div class="troubleshoot-link">
              <a id="open-emulator-location">Open Emulator Directory</a> | 
              <a href="https://developer.android.com/studio/run/emulator-troubleshooting" target="_blank">Android Emulator Troubleshooting</a>
            </div>
        </div>
        <script>
            (function() {
                const vscode = acquireVsCodeApi();
                const avdListContainer = document.getElementById('avd-list');
                const loadingText = document.getElementById('loading-text');
                const refreshBtn = document.getElementById('refresh-btn');
                const settingsBtn = document.getElementById('settings-btn');
                const detectSdkBtn = document.getElementById('detect-sdk-btn');
                const logsBtn = document.getElementById('logs-btn');
                const errorContainer = document.getElementById('error-container');
                const messageContainer = document.getElementById('message-container');
                const openEmulatorLocationLink = document.getElementById('open-emulator-location');
                const autoRefreshCheck = document.getElementById('auto-refresh-check');
                
                let refreshInterval = null;
                
                // Enable or disable auto-refresh
                function toggleAutoRefresh() {
                    clearInterval(refreshInterval);
                    
                    if (autoRefreshCheck.checked) {
                        refreshInterval = setInterval(() => {
                            vscode.postMessage({ command: 'refresh' });
                        }, 3000); // More frequent refresh for better responsiveness
                    }
                }
                
                // Set up auto-refresh on load
                toggleAutoRefresh();
                
                // Listen for auto-refresh checkbox changes
                autoRefreshCheck.addEventListener('change', toggleAutoRefresh);
                
                // Request AVD list on load
                vscode.postMessage({ command: 'getAvds' });
                
                // Handle refresh button
                refreshBtn.addEventListener('click', () => {
                    loadingText.style.display = 'block';
                    errorContainer.innerHTML = '';
                    messageContainer.innerHTML = '';
                    avdListContainer.innerHTML = '';
                    vscode.postMessage({ command: 'refresh' });
                });
                
                // Handle settings button
                settingsBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'openSettings' });
                });
                
                // Handle auto-detect SDK button
                detectSdkBtn.addEventListener('click', () => {
                    showMessage('Detecting Android SDK location...');
                    detectSdkBtn.disabled = true;
                    vscode.postMessage({ command: 'detectSdk' });
                });
                
                // Handle logs button
                logsBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'openLogs' });
                });
                
                // Add event listener for the "Open Emulator Directory" link
                openEmulatorLocationLink.addEventListener('click', () => {
                    vscode.postMessage({ command: 'openEmulatorLocation' });
                });
                
                // Listen for messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    switch (message.command) {
                        case 'avdList':
                            loadingText.style.display = 'none';
                            
                            // Show error if present
                            if (message.error) {
                                showError(message.error);
                            } else {
                                errorContainer.innerHTML = '';
                            }
                            
                            renderAvdList(message.avds);
                            break;
                            
                        case 'sdkDetectionResult':
                            detectSdkBtn.disabled = false;
                            if (message.paths?.success) {
                                showMessage(\`SDK detected at: \${message.paths.sdkPath}. Settings updated.\`);
                                // Refresh the list after a short delay
                                setTimeout(() => {
                                    vscode.postMessage({ command: 'refresh' });
                                }, 1000);
                            } else {
                                showError('Could not detect Android SDK. Please configure it manually.');
                            }
                            break;
                    }
                });
                
                function showMessage(message) {
                    messageContainer.innerHTML = '';
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'success-message';
                    messageDiv.textContent = message;
                    messageContainer.appendChild(messageDiv);
                }
                
                function showError(errorMessage) {
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'error-message';
                    errorDiv.textContent = errorMessage;
                    errorContainer.innerHTML = '';
                    errorContainer.appendChild(errorDiv);
                }
                
                function renderSetupGuide() {
                    const setupGuide = document.createElement('div');
                    setupGuide.className = 'setup-guide';
                    
                    setupGuide.innerHTML = \`
                        <h4>Android SDK Setup Guide</h4>
                        <p>To use this extension, you need to have the Android SDK installed and configured:</p>
                        <ul>
                            <li>Install Android Studio or the standalone SDK</li>
                            <li>Make sure the Android SDK tools are in your PATH or</li>
                            <li>Configure the SDK path in extension settings</li>
                            <li>Click "Auto-Detect SDK" to try to find it automatically</li>
                        </ul>
                        <p>Click the "Configure SDK" button and set the path to your Android SDK directory.</p>
                        <p>Common locations:</p>
                        <ul>
                            <li>Windows: C:\\Users\\USERNAME\\AppData\\Local\\Android\\Sdk</li>
                            <li>macOS: ~/Library/Android/sdk</li>
                            <li>Linux: ~/Android/Sdk</li>
                        </ul>
                        <p>If you're still having issues, click "View Logs" to see detailed diagnostic information.</p>
                        <h4>Troubleshooting Emulator Launch Issues</h4>
                        <p>If the emulator window appears and immediately closes:</p>
                        <ul>
                            <li>Make sure you have Intel HAXM or equivalent virtualization technology installed</li>
                            <li>Check that Hyper-V is enabled (or disabled) according to your emulator requirements</li>
                            <li>Try running the emulator directly from the command line</li>
                            <li>Check the logs for specific error messages</li>
                        </ul>
                    \`;
                    
                    avdListContainer.appendChild(setupGuide);
                }
                
                function renderAvdList(avds) {
                    avdListContainer.innerHTML = '';
                    
                    if (avds.length === 0) {
                        avdListContainer.innerHTML = '<p>No AVDs found. Create one in Android Studio or check your SDK configuration.</p>';
                        renderSetupGuide();
                        return;
                    }
                    
                    avds.forEach(avd => {
                        const avdItem = document.createElement('div');
                        avdItem.className = 'avd-item';
                        
                        const nameContainer = document.createElement('div');
                        nameContainer.className = 'name';
                        
                        const nameEl = document.createElement('div');
                        nameEl.textContent = avd.name;
                        
                        const statusEl = document.createElement('div');
                        statusEl.className = avd.status === 'running' ? 'status-running' : 'status-stopped';
                        statusEl.textContent = avd.status === 'running' ? '● Running' : '○ Stopped';
                        
                        nameContainer.appendChild(nameEl);
                        nameContainer.appendChild(statusEl);
                        avdItem.appendChild(nameContainer);
                        
                        const buttonContainer = document.createElement('div');
                        buttonContainer.className = 'button-row';
                        
                        const launchBtn = document.createElement('button');
                        launchBtn.className = 'button';
                        launchBtn.textContent = avd.status === 'running' ? 'Already Running' : 'Launch';
                        launchBtn.disabled = avd.status === 'running';
                        
                        if (avd.status !== 'running') {
                            launchBtn.addEventListener('click', () => {
                                vscode.postMessage({
                                    command: 'launchAvd',
                                    avdName: avd.name
                                });
                                launchBtn.textContent = 'Launching...';
                                launchBtn.disabled = true;
                                
                                // Give it some time and then refresh list
                                setTimeout(() => {
                                    vscode.postMessage({ command: 'refresh' });
                                }, 3000); // Reduced to 3 seconds for faster feedback
                                
                                // Add a second refresh after a bit longer
                                setTimeout(() => {
                                    vscode.postMessage({ command: 'refresh' });
                                }, 10000); // Another refresh after 10 seconds
                            });
                        }
                        
                        buttonContainer.appendChild(launchBtn);
                        avdItem.appendChild(buttonContainer);
                        avdListContainer.appendChild(avdItem);
                    });
                }
            })();
        </script>
    </body>
    </html>`;
  }
}