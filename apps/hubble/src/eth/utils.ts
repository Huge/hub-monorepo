import { hexStringToBytes, HubResult } from '@farcaster/utils';

export const bytes32ToBytes = (value: bigint): HubResult<Uint8Array> => {
  // Remove right padding
  let hex = value.toString(16);
  while (hex.substring(hex.length - 2) === '00') {
    hex = hex.substring(0, hex.length - 2);
  }

  return hexStringToBytes(hex);
};