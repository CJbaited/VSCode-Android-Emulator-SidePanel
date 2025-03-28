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

      // Convert to AvdInfo objects
      const avds = avdList.map(name => ({ name, status: 'stopped' as 'stopped' | 'running' }));

      // Check running emulators
      try {
        log(`Executing: ${paths.adb} devices`);
        const { stdout: runningOutput } = await exec(`"${paths.adb}" devices`);
        log(`adb devices output: ${runningOutput}`);
        
        const runningLines = runningOutput.split('\n');
        
        // Mark AVDs as running if they appear in adb devices output
        for (const avd of avds) {
          if (runningLines.some(line => line.includes('emulator') && line.includes('device'))) {
            avd.status = 'running';
            log(`Detected running AVD: ${avd.name}`);
          }
        }
      } catch (e) {
        log(`Error checking running devices: ${e}`);
      }

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

  private async _launchAvd(avdName: string) {
    try {
      const { paths, error } = await this._findAndroidTools();
      
      if (error) {
        vscode.window.showErrorMessage(`Failed to launch emulator: ${error}`);
        return;
      }
      
      const platform = os.platform();
      let command = '';
      
      if (platform === 'win32') {
        // For Windows, check if we need to run from the SDK directory
        if (paths.emulator === 'emulator') {
          // No path to emulator, likely not in PATH
          const config = vscode.workspace.getConfiguration('vscode-android-emulator-sidepanel');
          const sdkPath = config.get('sdkPath', '');
          
          if (sdkPath) {
            // Run with full path
            const expandedSdkPath = expandEnvVars(sdkPath);
            const emulatorPath = path.join(expandedSdkPath, 'emulator', 'emulator.exe');
            
            if (await exists(emulatorPath)) {
              command = `start cmd.exe /c "cd /d "${expandedSdkPath}\\emulator" && emulator.exe -avd ${avdName}"`;
              log(`Using full SDK path to launch emulator: ${command}`);
            } else {
              // Try alternative path
              const altEmulatorPath = path.join(expandedSdkPath, 'tools', 'emulator.exe');
              if (await exists(altEmulatorPath)) {
                command = `start cmd.exe /c "cd /d "${expandedSdkPath}\\tools" && emulator.exe -avd ${avdName}"`;
                log(`Using alternative path to launch emulator: ${command}`);
              } else {
                // Just try using the raw command
                command = `start cmd.exe /c "${expandedSdkPath}\\emulator\\emulator.exe" -avd ${avdName}`;
                log(`Falling back to raw command: ${command}`);
              }
            }
          } else {
            // No SDK path, show a helpful error
            const errorMsg = 'Unable to launch emulator: Android SDK path not configured';
            log(errorMsg);
            vscode.window.showErrorMessage(errorMsg + '. Please use "Auto-Detect SDK" or configure the SDK path manually.');
            return;
          }
        } else {
          // Windows - quote paths properly
          command = `start cmd.exe /c "\\"${paths.emulator}\\" -avd ${avdName}"`;
        }
      } else if (platform === 'darwin') {
        // macOS
        command = `osascript -e 'tell application "Terminal" to do script "\\"${paths.emulator}\\" -avd ${avdName}"'`;
      } else {
        // Linux
        command = `x-terminal-emulator -e "\\"${paths.emulator}\\" -avd ${avdName}"`;
      }

      log(`Launching AVD with command: ${command}`);
      
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
    } catch (error: any) {
      const errorMsg = `Failed to launch Android emulator: ${error?.message || String(error)}`;
      log(errorMsg);
      vscode.window.showErrorMessage(errorMsg);
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
            
            <div id="message-container"></div>
            <div id="error-container"></div>
            <p id="loading-text" class="loading">Loading available AVDs...</p>
            <div id="avd-list"></div>
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
                                }, 5000);
                            });
                        }
                        
                        avdItem.appendChild(launchBtn);
                        avdListContainer.appendChild(avdItem);
                    });
                }
            })();
        </script>
    </body>
    </html>`;
  }
}