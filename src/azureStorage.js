import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Azure Blob Storage helper functions
 */

export function initializeBlobServiceClient(storageAccount, connectionString) {
  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  } else if (storageAccount) {
    const credential = new DefaultAzureCredential();
    const accountUrl = `https://${storageAccount}.blob.core.windows.net`;
    return new BlobServiceClient(accountUrl, credential);
  }
  return null;
}

/**
 * Generate a SAS URL for secure blob access
 * @param {BlobServiceClient} blobServiceClient
 * @param {string} containerName
 * @param {string} blobName
 * @param {number} expiresInMinutes - How long the SAS token is valid (default: 60 minutes)
 * @returns {Promise<string>} The blob URL with SAS token
 */
export async function generateSasUrl(blobServiceClient, containerName, blobName, expiresInMinutes = 60) {
  try {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Try to get the account key from the connection string or use user delegation key
    const accountName = blobServiceClient.accountName;
    
    // For development with connection strings, extract the key
    if (blobServiceClient.credential instanceof StorageSharedKeyCredential) {
      const startsOn = new Date();
      const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"), // read-only
          startsOn,
          expiresOn,
        },
        blobServiceClient.credential
      ).toString();

      return `${blobClient.url}?${sasToken}`;
    } else {
      // For managed identity, use user delegation SAS
      const startsOn = new Date();
      const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

      const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"), // read-only
          startsOn,
          expiresOn,
        },
        userDelegationKey,
        accountName
      ).toString();

      return `${blobClient.url}?${sasToken}`;
    }
  } catch (error) {
    console.error("Failed to generate SAS URL:", error);
    // Fallback to regular URL (will only work if container has public access)
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    return blobClient.url;
  }
}

/**
 * Delete a blob from storage
 */
export async function deleteBlob(blobServiceClient, containerName, blobName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.deleteIfExists();
}

/**
 * Upload a blob to storage
 */
export async function uploadBlob(blobServiceClient, containerName, blobName, buffer, mimeType) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  
  // Ensure container exists
  await containerClient.createIfNotExists({
    access: "blob", // public read access for blobs
  });

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  // Upload buffer to blob
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: mimeType,
    },
  });

  return blockBlobClient.url;
}
