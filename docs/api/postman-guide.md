# Using the Postman Collection

TariffShield provides a Postman collection and environment to help you explore our public APIs quickly.

## Prerequisites

- [Postman](https://www.postman.com/downloads/) installed.

## Importing the Collection and Environment

1. Open Postman.
2. Click the **Import** button in the top left.
3. Select the `docs/tariff-shield.postman_collection.json` file from the TariffShield repository.
4. Click **Import** again and select the `docs/tariff-shield.postman_environment.json` file.
5. In the environment dropdown (top right of Postman), select the imported TariffShield environment.

## Configuring Authentication

Most endpoints require authentication. You need to obtain a Bearer token and set it in your Postman environment.

1. Make a request to the `POST /auth/login` endpoint (or use your app's login flow) to get a JWT.
2. In Postman, click the **Environment quick look** (eye icon in the top right).
3. Find the `auth_token` variable and click the pencil icon to edit it.
4. Paste your JWT into the **Current Value** field.
5. Save the environment.

## Running a Sample Request

1. Select the `GET /importers` request from the collection.
2. Verify that your environment is active and the `auth_token` is set.
3. Click the **Send** button.
4. View the response body to see the list of importers.

![Postman Sample Request](../assets/postman-sample.png)
*(Ensure your server is running locally or point the environment variable to your remote instance).*
