# Budibase Templates

## Adding a Template
To add a new template to this repository, you need to perform these steps:

First, export your app from the builder.

<img width="366" alt="Screenshot 2021-11-04 at 15 46 50" src="https://user-images.githubusercontent.com/11256663/140335367-1589369d-01b6-47ce-877e-193848258f2a.png">

Add a new folder under the `app` directory in the repo. Ensure that your folder name is all lowercase, and separated with dashes. For example:
`app/my-new-template`

<img width="1433" alt="Screenshot 2021-11-04 at 15 47 04" src="https://user-images.githubusercontent.com/11256663/140335420-3da25fa2-0e95-4caa-bd1e-83a5e9bf8a51.png">


Create a `definition.json`, which includes its name, icon etc. Here's an example `definition.json`:
```
{
  "name": "IT Ticketing System",
  "category": "IT",
  "description": "Keep on top of IT tickets and incoming requests for IT assistance.",
  "icon": "Help",
  "background": "#33AB84"
}
```

You then need to add your export file under `db/dump.txt`.
<img width="1436" alt="Screenshot 2021-11-04 at 15 47 56" src="https://user-images.githubusercontent.com/11256663/140335601-66beed19-ea92-48fe-9245-78252113b86b.png">


Merge to master, and it will automatically get picked up by BB

!<img width="737" alt="Screenshot 2021-11-04 at 15 48 07" src="https://user-images.githubusercontent.com/11256663/140335639-bcf88013-9bf2-4311-a8f0-af2e0d990f4e.png">

After merging, you create a destination URL for the template section of the website, simple append the name of your template to the end of:
https://budibase.app/builder?template=app/

For example:
https://budibase.app/builder?template=app/it-help-desk


