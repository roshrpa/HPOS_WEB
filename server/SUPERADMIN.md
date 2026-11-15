# Super admin console

Open `https://YOUR-DOMAIN/super`. Only the super admin can sign in there (shop users cannot).

## Make (or reset) the super admin
Run once on the server (needs the ADMIN_TOKEN from `.env`; the password must be 10+ characters):

    curl -s -X POST https://YOUR-DOMAIN/admin/super -H "X-Admin-Token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
      -d '{"name":"Roshan","password":"a-long-password"}'

## What the console does
- Companies and branches (each branch has a shop code typed once on every device).
- Branch admin: creates the branch's first admin (Owner) or resets his PIN. The admin then makes the users of his own branch.
- Users allowed: the branch admin cannot create more active users than this.
- Licence end date and Switched off (nobody of the branch can sign in or sync).
- Reset test data: wipes the bills and tablet orders of one branch and sets its stock to 100 on every device (type the shop code to confirm).

Existing data lives in company "Hollywood", branch "Branch 1", shop code `hollywood1`. Devices that send no shop code (old app versions) are put there.
